import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/herdr_delegate.py", import.meta.url));

describe("Herdr delegate state mutation", () => {
	test("serializes concurrent read-modify-write updates", () => {
		const probe = String.raw`
import concurrent.futures, json, pathlib, runpy, sys, tempfile
script = sys.argv[1]
run_dir = pathlib.Path(tempfile.mkdtemp(prefix='herdr-state-test-'))
module = runpy.run_path(script)
module['write_state'](run_dir, {'caller_tab':'caller','closed_tabs':[],'resources':[],'run_label':'test','run_slug':'test'})
def append(index):
    def change(state):
        state['resources'].append({'agent': f'agent-{index}'})
    module['mutate_state'](run_dir, change)
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    list(pool.map(append, range(24)))
state = json.loads((run_dir / 'state.json').read_text())
print(json.dumps({'count': len(state['resources']), 'unique': len({item['agent'] for item in state['resources']}), 'mode': oct((run_dir / 'state.json').stat().st_mode & 0o777)}))
`;
		const result = spawnSync("python3", ["-c", probe, script], { encoding: "utf8", timeout: 30_000 });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { count: 24, unique: 24, mode: "0o600" });
	});

	test("retains the prior private state when a mutation fails before replacement", () => {
		const probe = String.raw`
import json, pathlib, runpy, sys, tempfile
run_dir = pathlib.Path(tempfile.mkdtemp(prefix='herdr-state-failure-'))
module = runpy.run_path(sys.argv[1])
original = {'caller_tab':'caller','closed_tabs':[],'resources':[],'run_label':'test','run_slug':'test'}
module['write_state'](run_dir, original)
def fail_update(state):
    state['resources'].append({'agent':'partial'})
    raise RuntimeError('injected mutation failure')
try:
    module['mutate_state'](run_dir, fail_update)
except RuntimeError:
    pass
state = json.loads((run_dir / 'state.json').read_text())
print(json.dumps({'state':state,'mode':oct((run_dir / 'state.json').stat().st_mode & 0o777),'lock':(run_dir / '.state.lock').exists()}))
`;
		const result = spawnSync("python3", ["-c", probe, script], { encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 0, result.stderr);
		const proof = JSON.parse(result.stdout);
		assert.equal(proof.state.resources.length, 0);
		assert.equal(proof.mode, "0o600");
		assert.equal(proof.lock, false);
	});

	test("preserves close and report-repair diagnostics under contention", () => {
		const probe = String.raw`
import concurrent.futures, json, pathlib, runpy, sys, tempfile
run_dir = pathlib.Path(tempfile.mkdtemp(prefix='herdr-close-repair-'))
module = runpy.run_path(sys.argv[1])
state = {'caller_tab':'caller','closed_tabs':[],'resources':[{'agent':'worker','tab':'worker-tab','model_attempt':2,'report_repair_attempts':0,'report_repair_diagnostics':[]}],'run_label':'test','run_slug':'test'}
module['write_state'](run_dir, state)
class Result:
    stdout = ''
module['close_created_tab'].__globals__['run'] = lambda argv: Result()
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    list(pool.map(lambda fn: fn(), [lambda: module['close_created_tab'](run_dir, 'worker-tab'), lambda: module['record_repair_attempt'](run_dir, 'worker', 1, [{'code':'REPORT'}])]))
final = json.loads((run_dir / 'state.json').read_text())
resource = final['resources'][0]
print(json.dumps({'closed':final['closed_tabs'],'model_attempt':resource['model_attempt'],'repair_attempts':resource['report_repair_attempts'],'diagnostics':resource['report_repair_diagnostics']}))
`;
		const result = spawnSync("python3", ["-c", probe, script], { encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { closed: ["worker-tab"], model_attempt: 2, repair_attempts: 1, diagnostics: [[{ code: "REPORT" }]] });
	});

	test("lets a blocked agent proceed to report audit instead of rejecting before cleanup", () => {
		const probe = String.raw`
import json, pathlib, runpy, sys, tempfile
module = runpy.run_path(sys.argv[1])
run_dir = pathlib.Path(tempfile.mkdtemp(prefix='herdr-blocked-report-'))
module['write_state'](run_dir, {'caller_tab':'caller','closed_tabs':[],'resources':[],'run_label':'test','run_slug':'test'})
class Result:
    def __init__(self, returncode, stdout=''):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = ''
def fake_run(argv, check=True):
    if argv[1:3] == ['agent','wait']:
        return Result(1)
    return Result(0, json.dumps({'result':{'agent':{'agent_status':'blocked'}}}))
closed = []
module['wait_for_settled_agent'].__globals__['run'] = fake_run
module['wait_for_settled_agent'].__globals__['close_created_tab'] = lambda run_dir, tab: closed.append(tab)
module['wait_for_settled_agent'](run_dir, {'agent':'worker','tab':'worker-tab'})
print(json.dumps({'closed':closed}))
`;
		const result = spawnSync("python3", ["-c", probe, script], { encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { closed: [] });
	});

	test("recovers an orphaned state lock owned by a dead process", () => {
		const probe = String.raw`
import json, pathlib, runpy, sys, tempfile
run_dir = pathlib.Path(tempfile.mkdtemp(prefix='herdr-stale-lock-'))
module = runpy.run_path(sys.argv[1])
module['write_state'](run_dir, {'caller_tab':'caller','closed_tabs':[],'resources':[],'run_label':'test','run_slug':'test'})
lock = run_dir / '.state.lock'
lock.mkdir(mode=0o700)
(lock / 'owner.json').write_text(json.dumps({'pid': 99999999, 'createdAt': 0}))
module['mutate_state'](run_dir, lambda state: state['resources'].append({'agent':'recovered'}))
state = json.loads((run_dir / 'state.json').read_text())
print(json.dumps({'resources':len(state['resources']),'lock':lock.exists()}))
`;
		const result = spawnSync("python3", ["-c", probe, script], { encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { resources: 1, lock: false });
	});

	test("retains and cleans two concurrent real Herdr tab resources", { skip: process.env.PI_RUN_LIVE_HERDR !== "1", timeout: 30_000 }, () => {
		const probe = String.raw`
import concurrent.futures, json, os, pathlib, runpy, subprocess, sys, tempfile
module = runpy.run_path(sys.argv[1])
run_dir = pathlib.Path(tempfile.mkdtemp(prefix='herdr-live-state-'))
module['write_state'](run_dir, {'caller_tab':os.environ['HERDR_TAB_ID'],'closed_tabs':[],'resources':[],'run_label':'live-test','run_slug':'live-test'})
def start(index):
    result = subprocess.run(['herdr','tab','create','--workspace',os.environ['HERDR_WORKSPACE_ID'],'--cwd',os.getcwd(),'--label',f'pi-agent-wave state test {index}','--no-focus'],check=True,text=True,capture_output=True)
    value = json.loads(result.stdout)
    tab = str(value['result']['tab']['tab_id'])
    pane = str(value['result']['root_pane']['pane_id'])
    module['mutate_state'](run_dir, lambda state: state['resources'].append({'agent':f'harmless-{index}','tab':tab,'pane':pane}))
    return tab
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    tabs = list(pool.map(start, range(2)))
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    list(pool.map(lambda tab: module['close_created_tab'](run_dir, tab), tabs))
state = json.loads((run_dir / 'state.json').read_text())
print(json.dumps({'resources':len(state['resources']),'closed':len(state['closed_tabs']),'caller_preserved':state['caller_tab'] not in state['closed_tabs']}))
`;
		const result = spawnSync("python3", ["-c", probe, script], { encoding: "utf8", timeout: 25_000, env: process.env });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { resources: 2, closed: 2, caller_preserved: true });
	});
});

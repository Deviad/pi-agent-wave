#!/usr/bin/env python3
"""Real terminal dispatch proof; no model network calls and no default-session mutations."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PROVIDER = 'fake-e2e-worker'
FIXTURE_MODEL = 'fixture-worker'
SECRET = re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}")


def now():
    return datetime.now(timezone.utc).isoformat()


class MissingPrerequisite(RuntimeError):
    pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cols', type=int, default=200)
    parser.add_argument('--rows', type=int, default=60)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--keep', action='store_true')
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    captures = out / 'captures'
    captures.mkdir(exist_ok=True)
    log = out / 'fake-supervisor.ndjson'
    log.touch(mode=0o600)
    name = 'pi-wave-e2e-' + uuid.uuid4().hex[:12]
    env = {k: v for k, v in os.environ.items() if not k.startswith('HERDR_') and not k.startswith('FAKE_')}
    isolated = None
    temp = None
    pane = None
    before = None
    created_tmux = False
    run_dirs = []
    initial_dirs = set(p.resolve() for p in Path('/private/tmp').glob('delegate-graph-herdr-*'))
    started = time.time()
    evidence = dict(schemaVersion=1, startedAt=now(), finishedAt=None, versions={}, cols=args.cols, rows=args.rows,
                    herdrSessionName=name, herdrSocketPath=None, paneIds=[], runId=None, operationId=None,
                    attemptKey=None, dispatched=False, preflightBlockedReason=None, registeredEventSeen=False,
                    workerTabSeen=False, fixtureWorkerSeen=False, selectedModelIsFixture=False, fixtureHome=None, fixtureModel=None, defaultSessionUnchanged=False,
                    listOpened=False, detailOpened=False, detailRefreshed=False, backToList=False, appendedSecondRun=False, firstNumberStable=False,
                    secondRunId=None, detailWithoutHerdrTarget=False, collectReply=None, settledDetail=False, closedByOperator=False, reopened=False,
                    followDetailOpened=False, followClosed=False,
                    fakeSupervisorLogPath=str(log), capturesDir=str(captures), capturesSha256='',
                    secretScanFindings=0, cleanup={}, failureReason=None)
    counter = 0

    def command(argv, environment=None, check=True):
        result = subprocess.run(argv, env=environment or env, cwd=ROOT, text=True, capture_output=True, timeout=30)
        with (out / 'commands.ndjson').open('a') as handle:
            handle.write(json.dumps(dict(argv=argv, exitCode=result.returncode, stdout=result.stdout, stderr=result.stderr)) + '\n')
        if check and result.returncode:
            raise RuntimeError(f'{shlex.join(argv)}: {result.stderr.strip() or result.stdout.strip()}')
        return result

    def herdr(*argv, check=True):
        if isolated is None:
            raise RuntimeError('isolated socket has not been established')
        return command(['herdr', *argv], isolated, check)

    def data(*argv):
        return json.loads(herdr(*argv).stdout)['result']

    def capture():
        nonlocal counter
        text = herdr('pane', 'read', pane, '--source', 'visible').stdout
        (captures / f'{counter:03}.txt').write_text(text)
        ansi = herdr('pane', 'read', pane, '--source', 'visible', '--ansi').stdout
        (captures / f'{counter:03}.ansi').write_text(ansi)
        counter += 1
        return text

    def wait_for(predicate, timeout, reason):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(2)
        raise RuntimeError(reason)

    def send(text):
        herdr('pane', 'send-text', pane, text)
        herdr('pane', 'send-keys', pane, 'enter')

    code = 1
    try:
        for binary, expected in [('herdr', '0.8.0'), ('pi', '0.85.1'), ('agentfs', '0.6.4'), ('node', None), ('tmux', None)]:
            if not shutil.which(binary, path=env.get('PATH')):
                raise MissingPrerequisite(f'missing prerequisite: {binary}')
            result = command([binary, '-V' if binary == 'tmux' else '--version'], check=False)
            version = (result.stdout + result.stderr).strip()
            evidence['versions'][binary] = version
            if result.returncode or (expected and not re.search(r'(?<![\d.])' + re.escape(expected) + r'(?![\d.])', version)):
                raise MissingPrerequisite(f'missing prerequisite: {binary} {expected}: {version}')
        status = command(['herdr', 'status'], check=False)
        if status.returncode:
            raise MissingPrerequisite('missing prerequisite: accessible running default herdr session: ' + (status.stderr or status.stdout).strip())
        integration_source = Path(env.get('HOME', str(Path.home()))) / '.pi/agent/extensions/herdr-agent-state.ts'
        if not integration_source.is_file():
            raise MissingPrerequisite(f'missing prerequisite: installed Herdr Pi integration file to copy ({integration_source}); installation forbidden')
        before = command(['herdr', 'tab', 'list']).stdout
        (out / 'default-before.txt').write_text(before)
        temp = Path(tempfile.mkdtemp(prefix='pi-wave-e2e-'))
        # The Pi under test gets its own HOME: a fixture provider catalog, an auth entry for it, and a routing config
        # whose every tier is the fixture model. The delegate resolves routes, preflights credentials and copies
        # configuration from HOME, so dispatch is deterministic and never reads the operator's credential stores.
        fixture_home = temp / 'home'
        agent_dir = fixture_home / '.pi/agent'
        (agent_dir / 'extensions').mkdir(parents=True, mode=0o700)
        fixture_model = f'{FIXTURE_PROVIDER}/{FIXTURE_MODEL}'
        (agent_dir / 'models.json').write_text(json.dumps({'providers': {FIXTURE_PROVIDER: {
            'baseUrl': 'http://127.0.0.1:1', 'api': 'openai-completions', 'apiKey': 'FAKE_E2E_WORKER_KEY',
            'models': [{'id': FIXTURE_MODEL, 'name': 'Fixture worker', 'reasoning': False, 'input': ['text'], 'contextWindow': 100000,
                        'maxTokens': 4096, 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}}]}}}, indent=1))
        auth = agent_dir / 'auth.json'
        auth.write_text(json.dumps({FIXTURE_PROVIDER: {'type': 'api_key', 'key': 'fixture-key'}}))
        auth.chmod(0o600)
        tiers = ['tools', 'local-fast', 'test', 'coding', 'long-context', 'long-coding', 'review', 'reasoning', 'vision']
        (agent_dir / 'model-routing.jsonc').write_text(json.dumps({
            'tiers': {tier: {'models': [fixture_model], 'thinking': 'low', 'session': True} for tier in tiers},
            'adaptive': {'capability_floors': {'routine_tools': 'tools', 'planning': 'reasoning', 'implementation': 'coding',
                                               'independent_review': 'review', 'verification': 'test'}},
            'roles': {'thinker': {'tier': 'reasoning', 'capability_floor': 'planning'},
                      'implementer': {'tier': 'coding', 'capability_floor': 'implementation'},
                      'reviewer': {'tier': 'review', 'capability_floor': 'independent_review'},
                      'tester': {'tier': 'test', 'capability_floor': 'verification'},
                      'searcher': {'tier': 'tools', 'capability_floor': 'routine_tools'},
                      'source_searcher': {'tier': 'tools', 'capability_floor': 'routine_tools'}},
            'default_tier': 'tools'}, indent=1))
        shutil.copyfile(integration_source, agent_dir / 'extensions' / integration_source.name)
        integration = command(['herdr', 'integration', 'status'], {**env, 'HOME': str(fixture_home)})
        if not re.search(r'^pi: current\b', integration.stdout, re.M):
            raise RuntimeError('fixture home does not satisfy herdr integration status: ' + integration.stdout.strip())
        evidence['fixtureHome'] = str(fixture_home)
        evidence['fixtureModel'] = fixture_model
        command(['tmux', 'new-session', '-d', '-s', name, '-x', str(args.cols), '-y', str(args.rows)])
        created_tmux = True
        launch = ['env']
        for key in ('HERDR_ENV', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH'):
            launch += ['-u', key]
        launch += ['herdr', '--session', name]
        command(['tmux', 'send-keys', '-t', name, shlex.join(launch), 'Enter'])

        def socket_ready():
            sessions = json.loads(command(['herdr', 'session', 'list', '--json']).stdout)['sessions']
            return next((s['socket_path'] for s in sessions if s['name'] == name and s['running'] and Path(s['socket_path']).exists()), None)

        socket = wait_for(socket_ready, 30, 'isolated herdr session did not start')
        evidence['herdrSocketPath'] = socket
        isolated = {**env, 'HERDR_SOCKET_PATH': socket}
        workspaces = wait_for(lambda: data('workspace', 'list').get('workspaces'), 30, 'attached client created no workspace')
        workspace = workspaces[0]['workspace_id']
        tab = data('tab', 'create', '--workspace', workspace, '--cwd', str(ROOT), '--label', 'pi-under-test', '--focus')
        pane = tab['root_pane']['pane_id']
        evidence['paneIds'].append(pane)
        support = ROOT / 'extensions/pi-agent-wave/test/support'
        shim = support / 'acpx-shim'
        worker_env = {**isolated, 'PATH': str(shim) + os.pathsep + env['PATH']}
        if Path(shutil.which('acpx', path=worker_env['PATH'])).resolve() != (shim / 'acpx').resolve():
            raise RuntimeError('fake acpx PATH guard failed; refusing dispatch')
        pi = ['pi', '--no-extensions', '-e', str(ROOT / 'extensions/pi-agent-wave/index.ts'),
              '-e', str(support / 'fake-supervisor-provider.ts'), '--no-session', '--no-skills', '--no-prompt-templates',
              '--no-context-files', '--offline', '--model', 'fake-e2e/scripted']
        # The terminal child has its own deadline even if the harness is interrupted.
        pi = [sys.executable, '-c', 'import subprocess,sys; sys.exit(subprocess.run(sys.argv[1:], timeout=240).returncode)', *pi]
        # A pane line longer than the tty canonical input limit (1024 bytes on macOS) is never executed, so the
        # environment and the long argv live in a private script and the pane receives only its short path.
        launcher = out / 'launch-pi.sh'
        launcher.write_text('#!/bin/sh\n' + ''.join(f'export {key}={shlex.quote(value)}\n' for key, value in (
            ('HOME', str(fixture_home)), ('PI_CODING_AGENT_DIR', str(agent_dir)), ('PATH', worker_env['PATH']),
            ('DELEGATE_GRAPH_DB', str(temp / 'graph.db')), ('FAKE_SUPERVISOR_LOG', str(log)))) + 'exec ' + shlex.join(pi) + '\n')
        launcher.chmod(0o700)
        herdr('pane', 'run', pane, str(launcher))
        # The status bar names the model before startup finishes; input submitted while "Startup is still in
        # progress" is shown stays in the editor unsubmitted, so readiness also requires that banner to be gone.
        wait_for(lambda: (s := capture()) and 'scripted' in s and 'Startup is still in progress' not in s, 60, 'Pi fake model prompt not ready')
        time.sleep(1)
        send('/delegate --policy auto Add a README sentence')
        time.sleep(4)
        if '/delegate --policy auto Add a README sentence' in capture().split('\n')[-8:] and 'Delegate Graph run ' not in capture():
            key_retry = herdr('pane', 'send-keys', pane, 'enter', check=False)
            evidence['enterRetried'] = key_retry.returncode == 0
        # Pi clears its input line on submit, so readiness is the rendered supervisor contract or a command error.
        wait_for(lambda: (s := capture()) and ('Delegate Graph run ' in s or 'command:delegate' in s or 'FAKE_SUPERVISOR' in s), 20, 'delegate command produced no run message or error')
        screen = wait_for(lambda: (s if 'FAKE_SUPERVISOR_DISPATCHED' in s or 'FAKE_SUPERVISOR_BLOCKED' in s else None) if (s := capture()) else None,
                          120, 'dispatch timed out after 120 seconds')
        entries = [json.loads(line) for line in log.read_text().splitlines()]
        calls = [entry for entry in entries if entry['kind'] == 'toolCall']
        evidence['runId'] = calls[0]['arguments']['runId'] if calls else None
        dispatch = next((entry for entry in calls if entry['arguments']['op'] == 'dispatch'), None)
        evidence['operationId'] = dispatch['arguments']['operationId'] if dispatch else None
        for entry in entries:
            if entry['kind'] == 'toolResult' and entry.get('arguments', {}).get('op') == 'dispatch':
                try:
                    result = json.loads(entry['text'])
                except json.JSONDecodeError:
                    continue
                if result.get('blocked') == 'preflight':
                    evidence['preflightBlockedReason'] = result.get('reason', 'unspecified')
        if 'FAKE_SUPERVISOR_BLOCKED' in screen:
            raise RuntimeError('preflight blocked: ' + evidence['preflightBlockedReason'] if evidence['preflightBlockedReason'] else 'dispatch blocked; see supervisor log and captures')
        evidence['dispatched'] = True
        send('/graph log ' + evidence['runId'])
        time.sleep(2)
        capture()
        with sqlite3.connect(f'file:{temp / "graph.db"}?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            rows = {table: [dict(row) for row in db.execute(f'SELECT * FROM {table} WHERE run_id=?', (evidence['runId'],))]
                    for table in ('agents', 'runtime_attempts', 'events')}
        (out / 'database-rows.json').write_text(json.dumps(rows, indent=2))
        attempt = next(row for row in rows['runtime_attempts'] if row['operation_id'] == evidence['operationId'])
        evidence['attemptKey'] = attempt['attempt_key']
        evidence['selectedModelIsFixture'] = fixture_model in attempt['attempt_key']
        evidence['registeredEventSeen'] = any(row['type'] == 'runtime_attempt_registered' and row['operation_id'] == evidence['operationId'] for row in rows['events'])
        tabs = herdr('tab', 'list', '--workspace', workspace).stdout
        (out / 'worker-tabs.json').write_text(tabs)
        agent = next(row for row in rows['agents'] if row['id'] == attempt['agent_id'])
        evidence['workerTabSeen'] = bool(agent['tab_id'] and agent['tab_id'] in tabs)
        if agent.get('herdr_pane_id'):
            evidence['paneIds'].append(agent['herdr_pane_id'])

        # The private run directory is named by a slug of the run and operation ids; the agent row's cancel
        # script path names it exactly, so it is derived from there rather than matched by pattern.
        private_run_dir = Path(agent['acpx_cancel_script']).resolve().parents[2]
        if not private_run_dir.name.startswith('delegate-graph-herdr-') or private_run_dir in initial_dirs:
            raise RuntimeError(f'unexpected private run directory {private_run_dir}')
        run_dirs.append(private_run_dir)

        def fixture_seen():
            for stream in private_run_dir.rglob('worker.stdout.ndjson'):
                raw = stream.read_text()
                (out / 'worker.stdout.ndjson').write_text(raw)
                if 'fixture progress' in raw and 'end_turn' in raw:
                    return True
            return False

        evidence['fixtureWorkerSeen'] = bool(wait_for(fixture_seen, 30, 'fake acpx worker output not observed'))
        if not all(evidence[key] for key in ('registeredEventSeen', 'workerTabSeen', 'fixtureWorkerSeen', 'selectedModelIsFixture')):
            raise RuntimeError('registration, worker tab or fixture evidence missing')

        # --- The numbered agent list: opens on registration, digits+Enter open details, q/Esc navigate and close.
        first_name = agent['name']

        def key(name):
            herdr('pane', 'send-keys', pane, name)

        def choose(number):
            herdr('pane', 'send-text', pane, str(number))
            key('enter')

        def screen_with(*needles, timeout=30, reason='expected screen not reached'):
            return wait_for(lambda: (s if all(needle in s for needle in needles) else None) if (s := capture()) else None, timeout, reason)

        screen_with('agents (1) | keys: number then Enter opens details', f'1. {first_name} |', reason='agent list did not open after registration')
        evidence['listOpened'] = True
        choose(1)
        screen_with(f'agent 1: {first_name} | keys: q or Esc back to list', 'process running', reason='detail view did not open on 1 then Enter')
        evidence['detailOpened'] = True
        key('r')
        time.sleep(1.5)
        evidence['detailRefreshed'] = f'agent 1: {first_name} |' in capture()
        key('q')
        screen_with('agents (1) |', reason='q did not return from detail to the list')
        evidence['backToList'] = True

        # A worker from a second run started in the same session appends as 2 without renumbering 1.
        send('/delegate --policy auto Add a second README sentence')

        def second_dispatched():
            done = [json.loads(line) for line in log.read_text().splitlines()]
            results = [e for e in done if e['kind'] == 'toolResult' and e.get('arguments', {}).get('op') == 'dispatch']
            return len(results) >= 2

        wait_for(second_dispatched, 120, 'second run did not dispatch')
        with sqlite3.connect(f'file:{temp / "graph.db"}?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            all_agents = [dict(row) for row in db.execute('SELECT * FROM agents ORDER BY created_at')]
        (out / 'database-agents-all.json').write_text(json.dumps(all_agents, indent=2))
        second_agent = next(row for row in all_agents if row['run_id'] != evidence['runId'])
        evidence['secondRunId'] = second_agent['run_id']
        for row in all_agents:
            if row.get('acpx_cancel_script'):
                candidate = Path(row['acpx_cancel_script']).resolve().parents[2]
                if candidate.name.startswith('delegate-graph-herdr-') and candidate not in initial_dirs and candidate not in run_dirs:
                    run_dirs.append(candidate)
            if row.get('herdr_pane_id') and row['herdr_pane_id'] not in evidence['paneIds']:
                evidence['paneIds'].append(row['herdr_pane_id'])
        screen_with('agents (2) |', f'1. {first_name} |', f"2. {second_agent['name']} |", reason='second worker did not append to the list')
        evidence['appendedSecondRun'] = True
        evidence['firstNumberStable'] = True

        # The first worker's Herdr tab disappears; its details still open and no focus command runs.
        herdr('tab', 'close', agent['tab_id'])
        wait_for(lambda: agent['tab_id'] not in herdr('tab', 'list', '--workspace', workspace).stdout, 15, 'worker tab did not close')
        choose(1)
        screen = screen_with(f'agent 1: {first_name} |', reason='details did not open after the worker tab disappeared')
        evidence['detailWithoutHerdrTarget'] = 'agent_not_found' not in screen
        key('q')
        screen_with('agents (2) |', reason='q did not return to the list')

        # Settlement through the real collect operation, then the entry reads settled rather than running.
        send(f"collect {evidence['runId']} {evidence['operationId']}")
        screen = screen_with('FAKE_SUPERVISOR_COLLECT', timeout=180, reason='collect produced no reply')
        evidence['collectReply'] = next((line.strip() for line in screen.splitlines() if 'FAKE_SUPERVISOR_COLLECT' in line), None)
        choose(1)
        screen = screen_with(f'agent 1: {first_name} |', reason='details did not open after collect')
        evidence['settledDetail'] = 'process settled' in screen
        key('q')
        screen_with('agents (2) |', reason='q did not return to the list after collect')
        key('q')
        wait_for(lambda: (s := capture()) and 'agent list closed' in s and 'agents (2) |' not in s, 15, 'q on the list did not close it')
        evidence['closedByOperator'] = True
        send('/graph agents')
        screen_with('agents (2) |', f'1. {first_name} |', reason='/graph agents did not reopen the list')
        evidence['reopened'] = True

        # The explicit follow view opens details by number too. Opening it replaces the agent list; the second
        # run's thinker has not been collected, so it is the follow view's running worker number 1.
        send(f"/graph watch {evidence['secondRunId']} --follow")
        screen_with(f"watch {evidence['secondRunId']} |", f"1. {second_agent['name']} |", reason='follow view did not open')
        choose(1)
        screen = screen_with(f"agent 1: {second_agent['name']} |", reason='follow view did not open details on 1 then Enter')
        evidence['followDetailOpened'] = 'agent_not_found' not in screen and 'no pane to focus' not in screen
        key('q')
        screen_with(f"watch {evidence['secondRunId']} |", reason='q did not return from details to the follow view')
        key('q')
        wait_for(lambda: (s := capture()) and 'closed (closed by operator)' in s and f"watch {evidence['secondRunId']} |" not in s, 15, 'q did not close the follow view')
        evidence['followClosed'] = True
        code = 0
    except MissingPrerequisite as error:
        evidence['failureReason'] = str(error)
        code = 2
    except (RuntimeError, OSError, ValueError, KeyError, StopIteration, subprocess.TimeoutExpired) as error:
        evidence['failureReason'] = str(error)
    finally:
        cleanup = evidence['cleanup']
        cleanup['kept'] = args.keep
        errors = []
        if not args.keep:
            if isolated and pane:
                try:
                    herdr('pane', 'send-keys', pane, 'ctrl+c', check=False)
                except Exception as error:
                    errors.append(str(error))
            # Discover a partly started named session even if startup failed before polling succeeded.
            try:
                sessions = json.loads(command(['herdr', 'session', 'list', '--json']).stdout)['sessions']
                own = next((s for s in sessions if s['name'] == name and not s['default']), None)
                if own:
                    isolated = {**env, 'HERDR_SOCKET_PATH': own['socket_path']}
                    evidence['herdrSocketPath'] = own['socket_path']
                    herdr('server', 'stop')
                    cleanup['serverStopped'] = True
                else:
                    cleanup['serverStopped'] = not created_tmux
                if created_tmux:
                    command(['tmux', 'kill-session', '-t', name], check=False)
                if own:
                    command(['herdr', 'session', 'delete', name])
            except Exception as error:
                errors.append(str(error))
            safe_to_remove = not created_tmux or cleanup.get('serverStopped', False)
            if temp and safe_to_remove:
                shutil.rmtree(temp)
            cleanup['temporaryDbRemoved'] = temp is None or not temp.exists()
            if evidence['runId']:
                slug = re.sub(r'[^a-z0-9]+', '-', evidence['runId'].lower()).strip('-')
                for path in Path('/private/tmp').glob('delegate-graph-herdr-*'):
                    if path.resolve() not in initial_dirs and slug in path.name and path.stat().st_mtime >= started:
                        run_dirs.append(path.resolve())
            evidence['privateRunDirectories'] = sorted({str(p) for p in run_dirs})
            for path in set(run_dirs):
                if safe_to_remove:
                    shutil.rmtree(path)
            cleanup['runDirectoriesRemoved'] = all(not p.exists() for p in run_dirs)
        try:
            sessions_result = command(['herdr', 'session', 'list', '--json'])
            (out / 'sessions-after.json').write_text(sessions_result.stdout)
            sessions = json.loads(sessions_result.stdout)['sessions']
            cleanup['onlyDefaultSessionRemains'] = [s['name'] for s in sessions] == ['default']
            cleanup['namedSessionAbsent'] = not any(s['name'] == name for s in sessions)
            tmux = command(['tmux', 'ls'], check=False)
            (out / 'tmux-after.txt').write_text(tmux.stdout + tmux.stderr)
            verified_tmux = tmux.returncode == 0 or 'no server running' in tmux.stderr or 'No such file or directory' in tmux.stderr
            cleanup['tmuxVerified'] = verified_tmux
            cleanup['tmuxSessionAbsent'] = verified_tmux and not any(line.startswith(name + ':') for line in tmux.stdout.splitlines())
            if before is not None:
                after = command(['herdr', 'tab', 'list']).stdout
                (out / 'default-after.txt').write_text(after)
                # The operator keeps using the default session while the test runs, so only tab identity and
                # labels are compared; agent status and focus are volatile and not something the harness touches.
                def identity(listing):
                    return sorted((tab['workspace_id'], tab['tab_id'], tab['label']) for tab in json.loads(listing)['result']['tabs'])
                evidence['defaultSessionUnchanged'] = identity(before) == identity(after)
        except Exception as error:
            errors.append(str(error))
        cleanup['errors'] = errors
        if code == 0 and (errors or not evidence['defaultSessionUnchanged'] or (not args.keep and not all(cleanup.get(key) for key in ('serverStopped', 'temporaryDbRemoved', 'runDirectoriesRemoved', 'onlyDefaultSessionRemains', 'namedSessionAbsent', 'tmuxSessionAbsent')))):
            code = 1
            evidence['failureReason'] = 'cleanup or default-session verification failed'
        evidence['capturesSha256'] = hashlib.sha256(b''.join(p.read_bytes() for p in sorted(captures.iterdir()) if p.is_file())).hexdigest()
        evidence['secretScanFindings'] = sum(len(SECRET.findall(p.read_text(errors='replace'))) for p in out.rglob('*') if p.is_file() and p.name != 'evidence.json')
        if evidence['secretScanFindings']:
            code = 1
            evidence['failureReason'] = 'secret scan found captured credentials'
        evidence['finishedAt'] = now()
        evidence['exitCode'] = code
        (out / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
        print(evidence['failureReason'] or 'terminal dispatch proof passed')
        print('Evidence: ' + str(out / 'evidence.json'))
    return code


if __name__ == '__main__':
    raise SystemExit(main())

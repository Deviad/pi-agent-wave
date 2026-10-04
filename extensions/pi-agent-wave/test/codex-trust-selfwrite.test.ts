import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTS = new URL("../scripts", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ORIGINAL = 'model = "gpt-5.6-luna"\napproval_policy = "on-request"\n\n[projects."/Users/operator/repo"]\ntrust_level = "trusted"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n';

/**
 * Snapshots ORIGINAL as a Codex attempt's config.toml through the real copy_runtime_file, rewrites the attempt copy
 * with `observed(attempt)`, and runs the real verify_provider_links over it.
 */
function verify(observed: (attempt: string) => string): { ok: boolean; error: string | null; selfWrites: unknown[]; pristineKept: boolean } {
	const attempt = realpathSync(mkdtempSync(join(tmpdir(), "codex-trust-")));
	dirs.push(attempt);
	const script = `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import delegate_core as core
attempt = Path(sys.argv[2])
source = attempt / 'real-codex' / 'config.toml'
source.parent.mkdir()
source.write_text(sys.argv[3])
destination = attempt / 'providers' / 'codex' / 'config.toml'
destination.parent.mkdir(parents=True)
record = core.copy_runtime_file(source, destination, codex_trust_root=attempt)
core.write_private(destination, sys.argv[4].replace('<attempt>', str(attempt)))
resource = {'provider_links': [record]}
try:
    core.verify_provider_links(resource)
    outcome = {'ok': True, 'error': None}
except core.DelegateError as error:
    outcome = {'ok': False, 'error': str(error)}
outcome['selfWrites'] = core.configuration_self_writes(resource)
outcome['pristineKept'] = Path(record['pristine']).read_text() == sys.argv[3]
print(json.dumps(outcome))
`;
	const result = spawnSync("python3", ["-c", script, SCRIPTS, attempt, ORIGINAL, observed("<attempt>")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

const trustTable = (path: string) => `\n[projects."${path}"]\ntrust_level = "trusted"\n`;

describe("Codex project-trust self-write", () => {
	test("an unchanged snapshot verifies and records nothing", () => {
		const outcome = verify(() => ORIGINAL);
		assert.deepEqual(outcome, { ok: true, error: null, selfWrites: [], pristineKept: true });
	});

	test("trust entries added for directories inside the attempt verify and are recorded", () => {
		const mount = "<attempt>/agentfs-home/.agentfs/run/dg-thinker-0-0-abc/mnt";
		const appended = verify((attempt) => ORIGINAL + trustTable(mount.replace("<attempt>", attempt)));
		assert.equal(appended.error, null);
		assert.equal(appended.ok, true);
		assert.equal(appended.selfWrites.length, 1);
		const [write] = appended.selfWrites as { name: string; addedKeys: string[]; removedKeys: string[]; contentChanged: boolean }[];
		assert.equal(write.name, "config.toml");
		assert.equal(write.contentChanged, true);
		assert.deepEqual(write.removedKeys, []);
		assert.equal(write.addedKeys.length, 1);
		assert.match(write.addedKeys[0], /^projects\.".*\/agentfs-home\/\.agentfs\/run\/dg-thinker-0-0-abc\/mnt"$/);

		// Formatting is not compared: the same entry inserted between existing tables, without a blank line, verifies too.
		const inserted = verify((attempt) => ORIGINAL.replace("[mcp_servers.docs]", `[projects."${attempt}/agentfs-home/m"]\ntrust_level = "trusted"\n[mcp_servers.docs]`));
		assert.equal(inserted.ok, true, inserted.error ?? "");
	});

	const refused: [string, (attempt: string) => string, RegExp][] = [
		["a changed top-level key", () => ORIGINAL.replace('approval_policy = "on-request"', 'approval_policy = "never"'), /changed outside its project trust entries/],
		["a removed section", () => ORIGINAL.replace('\n[mcp_servers.docs]\ncommand = "docs-mcp"\n', ""), /changed outside its project trust entries/],
		["a changed existing trust entry", () => ORIGINAL.replace('[projects."/Users/operator/repo"]\ntrust_level = "trusted"', '[projects."/Users/operator/repo"]\ntrust_level = "untrusted"'), /changed an existing project entry/],
		["a removed existing trust entry", () => ORIGINAL.replace('[projects."/Users/operator/repo"]\ntrust_level = "trusted"\n', ""), /changed an existing project entry/],
		["a trust entry outside the attempt", () => ORIGINAL + trustTable("/Users/operator/elsewhere"), /trusts a directory outside the attempt: \/Users\/operator\/elsewhere/],
		["a trust entry escaping the attempt through ..", (attempt) => ORIGINAL + trustTable(`${attempt}/../escape`), /trusts a directory outside the attempt/],
		["a file that no longer parses", () => ORIGINAL + "\n[projects\n", /no longer valid TOML/],
	];
	for (const [label, observed, message] of refused) {
		test(`refuses ${label}`, () => {
			const outcome = verify(observed);
			assert.equal(outcome.ok, false, label);
			assert.match(String(outcome.error), /^runtime configuration snapshot /);
			assert.match(String(outcome.error), message);
			assert.deepEqual(outcome.selfWrites, []);
		});
	}

	test("a Codex attempt's config.toml carries the tolerance, and every other snapshot keeps exact bytes", () => {
		const home = realpathSync(mkdtempSync(join(tmpdir(), "codex-trust-env-")));
		dirs.push(home);
		const script = `
import json, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import delegate_core as core
home = Path(sys.argv[2])
(home / '.codex').mkdir()
(home / '.codex' / 'auth.json').write_text(json.dumps({'OPENAI_API_KEY': 'offline-fixture-not-a-credential'}))
(home / '.codex' / 'config.toml').write_text('model = "x"\\n')
(home / '.claude').mkdir()
(home / '.claude' / 'settings.json').write_text('{}')
(home / '.claude' / '.credentials.json').write_text(json.dumps({'claudeAiOauth': {'accessToken': 'offline-fixture-not-a-credential'}}))
os.environ['CODEX_HOME'] = str(home / '.codex')
os.environ.pop('PI_CLAUDE_OAUTH_TOKEN_FILE', None)
out = {}
for model in ('openai-codex/gpt-5.6-luna', 'claude-code/claude-opus-5'):
    attempt = home / ('attempt-' + model.split('/')[0])
    attempt.mkdir()
    (attempt / 'acpx-home').mkdir()
    try:
        _, links = core.provider_runtime_environment(attempt, attempt / 'acpx-home', home, model)
    except core.DelegateError as error:
        out[model] = str(error)
        continue
    out[model] = {Path(link['link']).name: {k: link.get(k) for k in ('selfWrites', 'trustRoot')} for link in links if link.get('kind') == 'snapshot'}
print(json.dumps(out))
`;
		const result = spawnSync("python3", ["-c", script, SCRIPTS, home], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
		assert.equal(result.status, 0, result.stderr);
		const out = JSON.parse(result.stdout);
		assert.deepEqual(out["openai-codex/gpt-5.6-luna"], { "config.toml": { selfWrites: "codex-trust", trustRoot: join(home, "attempt-openai-codex") } });
		assert.equal(out["claude-code/claude-opus-5"]["settings.json"].selfWrites, "tolerated");
	});
});

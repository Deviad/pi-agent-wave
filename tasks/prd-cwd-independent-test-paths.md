# Cwd-independent test paths for worker helper scripts

**Status:** Implemented (2026-09-08). Attempts: 1.

## Defect

`prd-settlement-convergence-gaps.md` closed one instance of a defect class: a test that
resolved `herdr_delegate.py` through `process.cwd()` only worked when the suite started from
the repository root. The class was not actually finished. Three test files still build
executable paths from the current directory:

- `test/acpx-herdr-bridge.test.ts` — `test/support/fake-acpx.mjs` and `scripts/herdr_delegate.py`
- `test/acpx-headless-transport.test.ts` — `scripts/` directory, `test/support/fake-acpx.mjs`, `scripts/headless_delegate.py`
- `test/acpx-doctor.test.ts` — `test/support/provider-snapshot-driver.py`

Reproduced, not theoretical. Same file, two directories:

```
repo root                   -> # pass 1  # fail 0
extensions/pi-agent-wave    -> # pass 0  # fail 1
```

The completion gate in `AGENTS.md` runs from the repository root, so these are green by
accident of habit. Running the suite from the package directory, or from an editor that
resolves the test file without setting cwd, loses the coverage.

## Scope

Resolve helper and support paths from `import.meta.url` instead of `process.cwd()`, which is
what `acpx-cleanup.test.ts`, `commands.test.ts` and `delegate-script-rehearsal.test.ts`
already do for the same scripts. No behaviour, topology, settlement, or evidence change: the
same assertions run against the same files, just located without depending on cwd.

Deliberately excluded: `acpx-event-mapping.test.ts` also uses `process.cwd()` to look for
recorded transcripts under `agent-output/`, but it guards them with an `existsSync` skip, so
cwd changes silently change whether the test runs rather than whether it passes. Making those
paths absolute would change which tests execute in a given run, which is a coverage decision
rather than a path fix, and needs its own call.

## Acceptance criteria

1. `node --experimental-strip-types --test --test-concurrency=1 extensions/pi-agent-wave/test/*.test.ts`
   from the repository root is green, and reports the same test count as before.
2. The three affected files run green when started from `extensions/pi-agent-wave`.
3. `grep -rn 'process.cwd()' extensions/pi-agent-wave/test/*.ts` returns only the
   `agent-output` transcript lookups named above.
4. Mutation proof: with a path still resolved against a directory that does not contain the
   script, the test fails loudly instead of skipping.
## Result

Criteria 1-4 met.

1. Full suite from the repository root is unchanged: 449 tests, 438 pass, 0 fail, 11 skipped
   (identical to the pre-change baseline).
2. `acpx-herdr-bridge`, `acpx-headless-transport` and `acpx-doctor` each run green started
   from `extensions/pi-agent-wave`, and the bridge file also green from the repository root.
3. Remaining `process.cwd()` uses are the excluded `agent-output` transcript lookups plus one
   deliberate `cwd: process.cwd()` in `acpx-doctor`.
4. Rewriting a resolved path to a file that does not exist makes the test fail (1 pass, 1
   fail) rather than skip, so the paths are binding rather than decorative.

### Found while verifying

`parsed_owned_paths()` in `scripts/delegate_core.py` resolves relative `--owned-paths-json`
entries against the worker's working directory. The Herdr bridge fixture passes the
workspace-relative `extensions/pi-agent-wave/lib/acpx-types.ts` and inherited the test
process's cwd, so starting the suite from the package directory produced
`.../extensions/pi-agent-wave/extensions/pi-agent-wave/lib/acpx-types.ts`. The doubled path
was latent, not new: the fixture never reached that assertion before, because its script path
lookup failed first.

The fixture now pins its child cwd to the repository root, which is where the suite is
documented to run. Resolution semantics were not changed. Whether relative owned paths should
resolve against the worker cwd at all is open: `scripts/production-review-bundle.ts` also
lists `extensions/pi-agent-wave/lib/acpx-types.ts` workspace-relatively, and under an npm
install into `~/.pi/agent/extensions` the operator's project root is not the repository root.
That needs its own decision rather than a drive-by change.

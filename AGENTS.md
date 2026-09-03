# pi-agent-wave development contract

## Scope and plan of record

This repository develops `@dpugliese/pi-agent-wave`. The package root is `extensions/pi-agent-wave/`.

`tasks/prd-package-delegate-graph.md` is the canonical issue and scope record. Before implementing any behavior, architecture, approach, or acceptance-criteria change, update that PRD first. Implement only the recorded scope. A specific documentation or maintenance edit explicitly requested by the user does not require a second issue.

## Product invariants

- Preserve the public `/delegate`, `/graph`, and `delegate_graph` contracts.
- Preserve graph topology, scheduling, retries, evidence gates, and model-policy behavior unless the PRD explicitly changes them.
- Worker execution is transport-neutral and ACPX-only. Headless operation must load with ACPX and AgentFS alone; Herdr is an optional presentation adapter selected only with complete executable/workspace identity. Implement this change only under `tasks/prd-air-controlled-editor-independent-orchestration.md` while preserving existing graph, settlement, and evidence behavior.
- Package exactly the pi-agent-wave graph extension plus questionnaire, cmux-session, and model-failover entry points.
- Herdr executables and Herdr-managed files remain external and must not enter the npm artifact.
- Do not recreate the legacy loose-install source directory; only migration code and migration tests may identify it.
- Do not restore retired orchestration instructions, files, environment aliases, fixed-role pane layouts, or generated workflow artifacts.

## Source ownership

- `extensions/pi-agent-wave/*.ts` — extension entry points and runtime.
- `extensions/pi-agent-wave/lib/` — package-private portable helpers and declarations.
- `extensions/pi-agent-wave/scripts/` — transport-neutral worker lifecycle, headless and optional Herdr adapters, evidence tooling, policy resolution, and migration.
- `extensions/pi-agent-wave/test/` — all automated verification.
- `extensions/pi-agent-wave/README.md` — user-facing installation and operations documentation.
- `README.md` — user-first product overview and install, run, inspection, and uninstall guide.
- `tasks/prd-package-delegate-graph.md` — issue and acceptance proof.
- `agent-output/` — generated evidence only; never package it.

When parallel workers are used, assign every writable path to exactly one worker. All unowned paths are read-only.

## Implementation rules

- Take a restore point before editing. Use the current commit for clean tracked files; copy untracked or already-dirty files before changing them.
- Make surgical changes and match the surrounding TypeScript, JavaScript, and Python style.
- Prefer types that make invalid states unconstructible. Do not use `any`, casts, or ignore directives merely to silence a valid type error.
- Comments document usage or constraints that code cannot express. Remove or update stale comments in the same change.
- Keep callers, declarations, tests, README files, package metadata, and migration behavior synchronized.
- Shipped code must use package-relative imports or the declared Pi peer packages. Never add `/Users/...`, Homebrew, npm-cache, or package-root escape imports.
- Use `PI_CODING_AGENT_DIR`, `PI_MODEL_ROUTING`, and `PI_MODEL_CATALOG` for configurable paths. Tests must use temporary agent directories.

## Tests and proof

Write a focused failing test before a behavioral fix, then make it pass. Use real reachable dependencies; fixtures are allowed for temporary Pi homes and seeded loose-install layouts, not as substitutes for installed Pi versions, npm, Git, SQLite, or the actual package loader.

From the repository root, the completion gate is:

```bash
node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts
```

Package-focused Bun checks:

```bash
bun test \
  extensions/pi-agent-wave/test/package-manifest.test.ts \
  extensions/pi-agent-wave/test/package-portability.test.ts \
  extensions/pi-agent-wave/test/package-artifact.test.ts \
  extensions/pi-agent-wave/test/package-docs.test.ts \
  extensions/pi-agent-wave/test/package-migration.test.ts \
  extensions/pi-agent-wave/test/questionnaire.test.ts \
  extensions/pi-agent-wave/test/cmux-session.test.ts \
  extensions/pi-agent-wave/test/model-failover.test.ts
```

The real installation matrix is intentionally Node-only because it exercises `node:sqlite`:

```bash
node --experimental-strip-types --test extensions/pi-agent-wave/test/package-install-rehearsal.test.ts
```

Additional required checks:

```bash
cd extensions/pi-agent-wave
npm run typecheck
npm pack --dry-run --json --ignore-scripts
npm publish --dry-run --json --ignore-scripts
cd ../..
git diff --check
```

Do not weaken an assertion to make a failing proof green. If a real prerequisite blocks a criterion, record the blocker in the PRD.

## Migration and system safety

- Migration defaults to dry-run. Never run `apply` against the real Pi installation without explicit authorization.
- Migration tests must use temporary `PI_CODING_AGENT_DIR` trees, preserve `herdr-agent-state.ts`, repair stale pi-fzf route-picker commands, validate private backup permissions, reject path-tampered manifests, and prove byte-exact settings plus `fzf.json` rollback.
- Installation rehearsals may use network subprocesses only against npm and temporary loopback Git infrastructure. They must not dispatch workers.
- Never modify the real `~/.pi/agent/extensions/`, Pi settings, credentials, model routing, databases, or caches as part of development verification.
- Never run `npm publish`, create or push a public repository, commit, push, merge, or apply a real migration unless the user explicitly asks.

## Documentation and release hygiene

- User-facing behavior changes require matching updates to `extensions/pi-agent-wave/README.md`.
- Development workflow changes require matching updates to this file and root `README.md`.
- Keep compatibility claims limited to versions proven by the real installation rehearsal.
- Do not invent `repository`, `homepage`, or `bugs` metadata.
- Do not commit `node_modules/`, tarballs, temporary files, caches, or generated installation trees.
- Before reporting completion, verify observable files, run the relevant checks, and report partial completion honestly.

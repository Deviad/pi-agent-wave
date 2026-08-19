# pi-agent-wave - A development and research harness for Pi agent workflows, with built-in observability.

This repository develops `@dpugliese/pi-agent-wave`, a Pi package for observable graph delegation. The distributable package lives in [`extensions/pi-agent-wave/`](extensions/pi-agent-wave/).

The package preserves the existing `/delegate`, `/graph`, and `delegate_graph` APIs and includes the questionnaire, cmux-session, and native model-failover companions. Herdr remains an external, preferred transport; the package falls back to its visible panel transport when Herdr is unavailable.

## Repository layout

- `extensions/pi-agent-wave/` — package source, manifest, user documentation, license, migration utility, and package-local helpers.
- `extensions/pi-agent-wave/test/` — graph, portability, artifact, companion, migration, initial configuration, and real installation tests.
- `tasks/prd-package-delegate-graph.md` — canonical issue, design decisions, acceptance criteria, and verification record.
- `agent-output/` — generated review evidence; never part of the npm artifact.
- `.pi/agents/project-overlay.md` — pointer to the canonical development instructions in `AGENTS.md`.

For installation, configuration, the `/delegate`, `/graph`, and `/failover` command reference, `delegate_graph` automation, runtime scenarios, migration, rollback, and user-facing security guidance, see [`extensions/pi-agent-wave/README.md`](extensions/pi-agent-wave/README.md).

## Development setup

```bash
cd extensions/pi-agent-wave
npm install --ignore-scripts --no-audit --no-fund
```

Dependencies are local to the package. Do not commit `node_modules/` or generated tarballs.

## Verification

Run the complete Node suite from the repository root:

```bash
node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts
```

This includes the real `npm pack` and loopback Git installation matrix for Pi `0.84.1` and `0.84.2`. It writes only to temporary directories and must clean up its repositories, processes, caches, and agent directories.

Run the package and companion tests under Bun:

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

The real installation rehearsal is Node-only because Bun does not provide `node:sqlite`.

Typecheck and inspect the npm artifact:

```bash
cd extensions/pi-agent-wave
npm run typecheck
npm pack --dry-run --json --ignore-scripts
npm publish --dry-run --json --ignore-scripts
```

`npm publish --dry-run` is verification only. Never run `npm publish` without explicit authorization.

## Development rules

- Update `tasks/prd-package-delegate-graph.md` before changing scope, approach, or acceptance criteria.
- Keep the package rooted at `extensions/pi-agent-wave/`. Do not recreate the legacy loose-install source directory; only migration code and migration tests identify it.
- Preserve `/delegate`, `/graph`, `delegate_graph`, graph topology, retry behavior, evidence gates, Herdr-first routing, and visible-panel fallback unless the issue explicitly changes them.
- Keep shipped imports package-relative or declared bare peers. Do not add machine-specific paths or references outside the package root.
- Never modify the real `~/.pi/agent/extensions/`, Pi settings, or caches during development tests.
- Do not publish, push, apply migration to the real installation, or invent repository/homepage/bugs URLs without explicit authorization.

See [`AGENTS.md`](AGENTS.md) for the full contributor and agent contract.

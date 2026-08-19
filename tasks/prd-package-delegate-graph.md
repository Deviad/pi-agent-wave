# PRD: Package Delegate Graph as `@dpugliese/pi-agent-wave`

**Status:** Core packaging, migration, initial user configuration, and cross-provider HTTP 429 failover are implemented and verified. Feature acceptance and proof are recorded in `tasks/prd-cross-provider-429-failover.md`; the package remains uncommitted, unpushed, and unpublished.

## Goal

Turn the existing loose Delegate Graph extension into the standalone public Pi package `pi-agent-wave`, rooted at `extensions/pi-agent-wave/`. It must install from npm or Git, remain portable outside the author’s machine, bundle the selected companion extensions, preserve current behavior, and support reversible migration without duplicate registrations.

## Approved decisions

- Package name: `@dpugliese/pi-agent-wave`.
- Package/source directory: `extensions/pi-agent-wave/`.
- Existing compatibility APIs remain `/delegate`, `/graph`, and `delegate_graph`; the rename does not break these public contracts.
- Initial package version: `0.1.0`.
- License: MIT.
- Repository, homepage, and issue-tracker URLs: deferred. Do not invent them; omit them until separately approved.
- Compatibility proof: Pi `0.84.1` plus `0.84.2`, the registry release observed during planning. Do not claim compatibility beyond the tested matrix.
- The project-local migration was explicitly applied by the user. No additional real-install mutation, npm publication, public repository creation, or push is authorized beyond repairing stale references caused by that migration.
- This file is the package umbrella issue and scope record. Linked feature acceptance records are `tasks/prd-initial-configuration.md` and `tasks/prd-cross-provider-429-failover.md`; superseded external planning files and generated role-workflow artifacts remain excluded.

## Verified packaging baseline

- The active host provides Node `22.16.0`, Bun `1.3.14`, npm `10.9.2`, Git `2.54.0`, and Pi `0.84.1`; Pi `0.84.2` was confirmed in the npm registry during planning.
- Pi package documentation requires the `pi-package` keyword, relative `pi.extensions` entries, Pi core packages as unbundled peer dependencies with `"*"`, npm packages under the agent directory’s `npm/`, Git packages under `git/`, and settings in `settings.json`.
- Current portability defects are known in `delegation-identity.ts`, `index.ts`, `cmux-session.ts`, `route-picker.ts`, and `model-failover.ts`; their escaped or legacy imports are the intended FR-3 repair surface.
- The real loose-install migration inventory is `delegate-graph/`, `questionnaire.ts`, `cmux-session.ts`, and `model-failover.ts`. `herdr-agent-state.ts` is Herdr-managed and must remain excluded.
- The applied migration exposed stale `route` and `delegate-model` commands in the active pi-fzf configuration: their list and preview commands still referenced the removed loose route-picker. Migration must rewrite those exact command paths to the installed package copy and retain byte-exact rollback data.
- The planning baseline had one relocated-suite failure in `commands.test.ts`, caused by the escaped `typebox` import resolving against the repository rather than the agent installation. Portability work must fix the import; tests must not weaken the expectation.
- Pi documents npm and Git install sources but not a tarball source or local `file://` Git example. Before publication, npm compatibility is proven by installing the exact `npm pack` tarball into a temporary agent-directory npm tree and loading it with each real Pi version’s `DefaultResourceLoader`; this does not claim the unpublished `pi install npm:` registry path was exercised. Git compatibility serves a temporary bare repository at an owner/repository-shaped path over loopback HTTP and exercises the real `pi install http://…` Git-package path on both versions. The owner/repository path shape is required by Pi’s Git source parser; single-segment rehearsal URLs are intentionally rejected as local paths.
- The legacy global `tests/model-failover-native-rehearsal.ts` still targets Pi `0.80.3` and is not valid compatibility proof for the installed `0.84.1` runtime. Package-owned failover and install-rehearsal tests must provide the required `0.84.1`/`0.84.2` proof instead of weakening assertions or treating that legacy rehearsal as green.

## Approach

1. Import the current Delegate Graph source and tests into `extensions/pi-agent-wave/` without editing the real loose installation.
2. Add a standards-compliant Pi/npm manifest and package only explicit public files.
3. Replace package-root escapes with bare peer imports and package-private routing/JSONC helpers.
4. Add package-owned entry points for questionnaire, cmux session metadata, and native model failover while excluding Herdr-managed integration files.
5. Add a migration utility with dry-run, apply, and rollback modes tested only against temporary `PI_CODING_AGENT_DIR` trees, including repair and exact rollback of active pi-fzf route-picker command references.
6. Add isolated npm-tarball and Git-install rehearsals for Pi `0.84.1` and `0.84.2`.
7. Document installation, security, configuration, migration, rollback, uninstall, contents, and tested compatibility.
8. Retire the obsolete Role Pipeline and cmux-agent-supervision surfaces, merge their relevant packaging requirements into this PRD, and remove their active instructions, standalone plans, generated current-project artifacts, and unused route/config remnants.

## Affected components

- `extensions/pi-agent-wave/package.json`
- pi-agent-wave runtime and scripts under `extensions/pi-agent-wave/`
- Package-private model-routing and JSONC helpers
- Package-owned companion extension entry points
- Migration tooling and pi-fzf route-picker reference repair
- Package README and MIT license
- Existing and new tests under `extensions/pi-agent-wave/test/`
- One-time host cleanup of obsolete orchestration skills and active references
- Current-project generated role-workflow markers, task briefs, and handoffs

## Acceptance criteria

### Retire obsolete orchestration surfaces

- [x] `~/.pi/agent/skills/role-pipeline/`, `~/.pi/agent/skills/cmux-agent-supervision/`, `~/.pi/agent/prompts/pipeline.md`, `~/.pi/agent/templates/pipeline.conf.template`, and `~/.pi/agent/scripts/setup-pipeline-models.sh` do not exist. Proof: direct `test ! -e` checks.
- [x] Active policy and reusable skill files contain no `role-pipeline`, `/pipeline`, or `cmux-agent-supervision` reference; `SYSTEM.md` routes cmux operations through the surviving `cmux` skill only. Fixed BA/Architect/Coder/Reviewer/Tester pane layouts, role launchers, marker protocols, and supervision-probe instructions from the retired workflows are also removed from active `SYSTEM.md`, `AGENTS.md`, `skills/cmux/SKILL.md`, and `skills/self-improvement-skill/SKILL.md`. Proof: focused exact-name and semantic `rg` gates over active files, excluding dependency trees and historical records.
- [x] Role-only model routes remain removed while the six Delegate Graph routes `thinker`, `implementer`, `reviewer`, `tester`, `auditor`, and `searcher` remain. Proof: `node extensions/pi-agent-wave/route-picker.ts --list` and route-picker tests.
- [x] Superseded external plans `~/.pi/agent/tasks/prd-remove-role-pipeline.md` and `~/.pi/agent/tasks/prd-package-delegate-graph.md` are removed after this PRD contains their durable package requirements and cleanup criteria. Proof: direct absence checks plus review of this file.
- [x] Current-project leftovers `.cmux-status/` and `agent-output/package-delegate-graph/` are removed after their durable requirements are merged here; `.pi/agents/project-overlay.md` no longer advertises generated role handoffs. Proof: direct absence checks and focused `rg` over the project excluding `.git` and historical external records.
- [x] Immutable historical backups, completed session snapshots, and evidence records outside this current project are not rewritten merely to erase past names. Proof: cleanup commands target only the active paths named above.
- [x] Delegate Graph command, companion, and route-picker tests remain green after cleanup. Proof: the final relocated/package suite passes 109 tests in 19 suites with 0 failures.

### Package manifest and artifact

- [x] `package.json` has `name: "@dpugliese/pi-agent-wave"`, `type: "module"`, a `pi-package` keyword, explicit `files`, publish access, description, version, MIT license, and one explicit `pi.extensions` entry for Delegate Graph and each selected companion. Proof: `bun test extensions/pi-agent-wave/test/package-manifest.test.ts`.
- [x] Deferred repository, homepage, and bugs URLs are absent rather than fabricated. Proof: `bun test extensions/pi-agent-wave/test/package-manifest.test.ts`.
- [x] Pi runtime imports `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, and `typebox` are declared as `peerDependencies` with `"*"` and are absent from `bundledDependencies`. Proof: manifest test.
- [x] Separately packaged Pi resources, if any, follow Pi’s `dependencies` plus `bundledDependencies` contract; otherwise those fields stay empty. Proof: manifest test.
- [x] `npm pack --dry-run --json` and `npm publish --dry-run` succeed without publishing and expose only intended files. Proof: `package-artifact.test.ts`.

### Portability and behavior

- [x] Shipped source has no import escaping the package root, no `/Users/spotted`, fixed Homebrew/npm-cache path, `../../npm/node_modules`, or `@mariozechner/pi-coding-agent` import. Proof: `package-portability.test.ts`.
- [x] `delegation-identity.ts` imports `@earendil-works/pi-tui`; `index.ts` imports `typebox` by bare package name. Proof: portability test.
- [x] Package-private JSONC/model-routing helpers resolve an explicit path or `PI_MODEL_ROUTING`, then `PI_CODING_AGENT_DIR`, without hard-coded `~/.pi/agent`. Proof: portability and route-picker tests.
- [x] Existing Delegate Graph scheduling, routing, retries, evidence ledger, Herdr-first selection, and visible-panel fallback remain unchanged. Proof: complete existing suite after relocation.
- [x] `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` passes.

### Companion extensions

- [x] Package-owned questionnaire, cmux-session, and model-failover entry points exist and each appears exactly once in `pi.extensions`. Proof: manifest test.
- [x] Questionnaire behavior works without fixed host paths. Proof: `questionnaire.test.ts`.
- [x] Native model failover works without fixed host paths. Proof: `model-failover.test.ts`.
- [x] cmux-present and cmux-absent metadata behavior is covered. Proof: `cmux-session.test.ts`.
- [x] `herdr-agent-state.ts`, Herdr executables, and other Herdr-managed files are not shipped; README states that Herdr integration remains external. Proof: artifact and docs tests.

### Isolated installation rehearsal

- [x] The exact npm tarball installs under a temporary `PI_CODING_AGENT_DIR` and loads `delegate_graph` and `questionnaire` without module-resolution errors on Pi `0.84.1` and `0.84.2`. Proof: `package-install-rehearsal.test.ts`.
- [x] A temporary Git repository made from package source exercises Pi’s Git-package installation path and registers the same resources on the tested version matrix. Proof: install rehearsal test.
- [x] A bounded initialization/status read succeeds without worker dispatch or real configuration changes. Proof: captured rehearsal assertions.
- [x] Temporary config, caches, Git repositories, and processes are removed on both success and failure. Proof: cleanup assertions.

### Reversible migration

- [x] Read-only preflight finds loose Delegate Graph and selected companions while excluding Herdr-managed files. Proof: `package-migration.test.ts` against a temporary fake Pi directory.
- [x] Dry-run is the default, prints exact operations, and leaves filesystem/settings hashes unchanged. Proof: migration test.
- [x] Apply moves conflicts to a private backup outside auto-discovered extension directories before enabling the package; rollback restores exact prior files/settings and rejects path-tampered manifests. Proof: migration test.
- [x] Post-migration registration remains exactly once for Delegate Graph and all three companions. Proof: migration apply assertions plus actual-loader install rehearsal assertions.
- [x] Tests confirm the real `~/.pi/agent` extension paths remain unchanged.
- [x] Dry-run reports stale pi-fzf route-picker references without changing `fzf.json`; apply rewrites only the `route` and `delegate-model` list/preview paths to the installed package’s `route-picker.ts`; rollback restores the original `fzf.json` bytes. Proof: focused migration tests with a temporary Pi home, idempotency coverage, and end-to-end execution of both repaired list/preview commands against the real configuration.

### Public documentation

- [x] README documents npm and Git installation, package contents, Pi/Herdr prerequisites, Herdr-first visible-panel fallback, configuration, migration, rollback, uninstall, and the `0.84.1`/`0.84.2` tested matrix. Proof: `package-docs.test.ts`.
- [x] README warns that Pi extensions execute with full system access and tells users to review source before installation. Proof: docs test.
- [x] `LICENSE` contains the MIT license and matches `package.json#license`. Proof: docs test.

## Verification

- Node suite: 109 tests in 19 suites passed with 0 failures and 0 skipped.
- Bun package/companion suite: 23 passed, 0 failed, with the Node-only real-install matrix intentionally skipped under Bun because Bun does not provide `node:sqlite`.
- `npm run typecheck`: passed.
- Active-path cleanup and `git diff --check`: passed.
- Real pi-fzf repair: applied via private manifest `~/.pi/agent/migration-backups/pi-agent-wave/fzf-repair-20260819-181601/manifest.json`; both `route` and `delegate-model` list/preview commands exit successfully and no removed route-picker path remains.
- Independent visible Herdr Reviewer: PASS. Fresh-context semantic Auditor: PASS. Evidence ledger: `agent-output/pi-agent-wave-final-review/delegate-ledger/` audited with no findings.

## Non-goals

- Redesign graph topology, scheduler, store, retry policy, ledger, model-selection UX, or transport behavior.
- Package Herdr, cmux skills, obsolete orchestration skills, user routing settings, credentials, databases, ledgers, or generated output.
- Add companions beyond questionnaire, cmux session integration, and native model failover.
- Claim compatibility outside Pi `0.84.1` and `0.84.2`.
- Publish to npm, create a public repository, push commits, modify the real Pi installation, or migrate real loose files.

## Completion gate

All listed proof commands must pass against package artifacts and temporary installations. The one-time obsolete-orchestration cleanup must also pass its absence and active-reference gates before packaging is complete. Any criterion blocked by an external prerequisite must be reported as blocked; it must not be replaced with a simulation when the real local dependency is reachable.

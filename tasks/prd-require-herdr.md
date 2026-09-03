# PRD: Require Herdr and make the README user-first

**Status:** Historical implementation is verified. `tasks/prd-air-controlled-editor-independent-orchestration.md` supersedes only this issue's mandatory-Herdr load/transport invariant: headless operation must work without Herdr, while the proven Herdr behavior remains an optional presentation adapter. Panel fallback remains retired. The change is not committed, pushed, or published.

## Overview

This document remains the historical proof for panel removal and Herdr behavior. Its mandatory-load requirement is replaced by the transport-neutral, Air/headless plan in `tasks/prd-air-controlled-editor-independent-orchestration.md`.

pi-agent-wave currently treats Herdr as preferred and automatically falls back to a panel transport. Users instead need one supported execution model: install Herdr, start it in their project, run Pi inside that Herdr workspace, and use pi-agent-wave from there.

The public repository README must lead with what pi-agent-wave is, why a Pi user should use it, and exact commands to install Herdr, install and initialize pi-agent-wave, run delegation, inspect a run, and uninstall the package. The runtime must match those instructions by refusing to load when Herdr is missing or Pi is not running inside a verified Herdr workspace. Panel transport support must be removed.

## Goals

- Give new users a concise, task-oriented path from an empty machine to their first observable delegation run.
- Use plain, easily understandable prose; define necessary technical terms and keep implementation detail out of the main user journey.
- Make Herdr an enforced external prerequisite rather than a recommendation.
- Remove the panel transport and its public options so there is one supported worker transport.
- Keep installation and uninstallation honest while `@dpugliese/pi-agent-wave` is not yet published to npm.
- Preserve graph topology, scheduling, retries, evidence gates, model-policy behavior, and the public `/delegate`, `/graph`, and `delegate_graph` names.

## User Stories

### US-001: Understand and install pi-agent-wave

**Description:** As a Pi user, I want the repository README to explain the product, its benefits, prerequisites, and working installation commands so that I can decide whether to use it and install it without reading development documentation.

**Acceptance Criteria:**

- [x] Root `README.md` opens with a user-facing explanation of what pi-agent-wave is and why observable, evidence-gated graph delegation is useful. Proof: focused assertions in `extensions/pi-agent-wave/test/package-docs.test.ts` inspect root and package README content.
- [x] The main user journey uses short sections and plain language, defines necessary terms on first use, and does not require readers to understand the internal graph state machine, transport types, package layout, or test harness. Proof: a fresh-context documentation reviewer can answer what the product is, why to use it, how to install it, how to run it, and how to uninstall it using only root `README.md`, with the result recorded in this issue's verification section.
- [x] Root `README.md` states that Herdr is mandatory, links to `https://herdr.dev/docs/install/`, and includes the official `brew install herdr`, Linux/macOS installer, Windows installer, and `herdr --version` verification commands. Proof: `package-docs.test.ts` literal command and URL assertions.
- [x] Root `README.md` documents a currently working source install using `https://github.com/Deviad/pi-agent-wave` plus Pi's local-path install form. The npm command is present only in a clearly marked "after publication" section while the registry endpoint returns `404`. Proof: docs test plus a recorded registry status check in this issue before completion.
- [x] Root `README.md` documents working source-checkout initialization with direct `node ./pi-agent-wave/extensions/pi-agent-wave/scripts/*.mjs` commands, including a read-only plan, explicit apply, and doctor. It labels the `pi-agent-wave-init` and `pi-agent-wave-doctor` binaries as available only after npm publication because Pi's local-path install does not link package binaries. Proof: docs test literals plus a temporary local-path install that executes the direct scripts and confirms the bin names are absent.
- [x] `extensions/pi-agent-wave/README.md` agrees with the root README on prerequisites, install, run, and uninstall behavior while retaining detailed command reference and security guidance. Proof: docs test reads both files and rejects optional-Herdr or panel-fallback wording.

### US-002: Run pi-agent-wave only inside Herdr

**Description:** As a user, I want pi-agent-wave to fail immediately with an actionable message when Herdr is unavailable so that I do not start a workflow that cannot dispatch observable workers.

**Acceptance Criteria:**

- [x] A focused failing test is added before the runtime change and proves every package-owned extension entry point refuses registration when the `herdr` executable is unavailable. Proof: new `extensions/pi-agent-wave/test/herdr-requirement.test.ts` initially failed, then passed.
- [x] Package loading also fails when Herdr is installed but the Pi process lacks verified `HERDR_ENV`, `HERDR_WORKSPACE_ID`, or `HERDR_TAB_ID` values. The error distinguishes "install Herdr" from "start Herdr and run Pi inside its workspace" and includes `https://herdr.dev/docs/install/`. Proof: `herdr-requirement.test.ts` covers each missing prerequisite.
- [x] Herdr validation is implemented once in a package-private typed helper and reused by `index.ts`, `questionnaire.ts`, `cmux-session.ts`, and `model-failover.ts` before they register commands, tools, or hooks. Proof: focused source assertions plus the package loader test.
- [x] The real installed `herdr` binary passes the prerequisite check and the real Pi loader registers the package on the tested Pi matrix. Proof: `herdr-requirement.test.ts` invokes the real `herdr --version`; `package-install-rehearsal.test.ts` loads all package entry points through the real Pi loader on each tested version. A fabricated Herdr command is not accepted as proof that the reachable dependency works.
- [x] `npm run typecheck` passes from `extensions/pi-agent-wave/`. Proof: command exit status.

### US-003: Remove panel transport support

**Description:** As a user, I want Herdr to be the only transport so that the documented execution model and runtime behavior cannot diverge.

**Acceptance Criteria:**

- [x] `scripts/delegate.ts` accepts and produces only Herdr transport invocations; `--transport panel` and automatic panel fallback are rejected or removed. Proof: focused assertions in `delegate-script-rehearsal.test.ts`.
- [x] `scripts/panel.ts` is absent from source and the packed npm artifact. Proof: direct absence assertion and `package-artifact.test.ts`.
- [x] Public tool parameters, runtime types, store inputs, status rendering, commands, and tests no longer expose `panel`, `paneId`, or `PANEL_*` behavior. Proof: focused tests plus an `rg` gate over shipped runtime, declarations, tests, and both active READMEs.
- [x] New SQLite stores do not create panel-only fields. Existing databases may retain unused extra columns, but no destructive database rewrite or deletion is performed. Proof: store schema test against a new temporary database and migration tests against an existing temporary database.
- [x] Graph topology, joins, retry budgets, evidence validation, frozen model policy, and HTTP 429 failover remain unchanged. Proof: complete Node test suite.

### US-004: Start, inspect, and uninstall from documented commands

**Description:** As a user, I want exact run and uninstall commands so that I can operate and remove pi-agent-wave without reverse-engineering the package.

**Acceptance Criteria:**

- [x] Root `README.md` shows the sequence `herdr`, then `pi` inside the Herdr workspace, followed by a concrete `/delegate <task>` example. Proof: docs test literal command assertions.
- [x] Root `README.md` includes `/graph status <runId>` and `/graph log <runId>` as the minimum inspection workflow and links to the detailed package command reference. Proof: docs test.
- [x] Root and package READMEs show the correct `pi remove` command for the working local-path source install and the future npm install, clearly separated by installation source. Proof: docs test and a temporary `PI_CODING_AGENT_DIR` install/remove rehearsal using the real Pi CLI.
- [x] The uninstall section states that removing pi-agent-wave does not remove the separately installed Herdr runtime or user-created Delegate Graph data. Proof: docs test.
- [x] `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` passes. Proof: command exit status.

## Functional Requirements

- FR-1: The root README must be written primarily for users, not repository developers.
- FR-2: The root README must explain what pi-agent-wave does and why users should choose observable, evidence-gated graph delegation.
- FR-3: The README must present Herdr as mandatory and provide current official installation commands for macOS, Linux, and Windows.
- FR-4: The README must provide exact commands to install, initialize, run, inspect, and uninstall pi-agent-wave for the currently working source-checkout path, and must separate those commands from future npm-provided binaries.
- FR-5: The README must not present the npm installation command as currently available until the registry package exists.
- FR-6: Every package-owned Pi extension entry point must fail before registration unless the Herdr executable and complete Herdr workspace identity are available.
- FR-7: Failure messages must be actionable and must not silently select another transport.
- FR-8: Herdr must be the only supported and representable worker transport for new runs.
- FR-9: The panel executable, options, runtime fields, documentation, and tests must be removed.
- FR-10: Existing user databases must not be destructively rewritten merely to remove obsolete panel columns.
- FR-11: Herdr must remain externally installed and must not be bundled into the npm artifact.
- FR-12: The existing public `/delegate`, `/graph`, and `delegate_graph` names and non-transport graph behavior must remain compatible.
- FR-13: User-facing prose must be easily understandable by humans: prefer familiar words, short direct sentences, concrete benefits, and brief definitions over internal terminology.

## Non-Goals

- Bundle, install, update, or uninstall Herdr on the user's behalf.
- Publish `@dpugliese/pi-agent-wave` to npm.
- Redesign graph topology, scheduling, retry policy, evidence gates, model selection, or model failover.
- Delete existing Delegate Graph databases or historical run data.
- Preserve panel-backed run compatibility or provide a manual panel override.
- Add a graphical onboarding flow or website.

## Design / Technical Considerations

- Use the official Herdr installation documentation at `https://herdr.dev/docs/install/` and quick start at `https://herdr.dev/docs/quick-start/` as command sources.
- Validate the executable by invoking `herdr --version` without a shell, then validate `HERDR_ENV=1`, `HERDR_WORKSPACE_ID`, and `HERDR_TAB_ID`. Keep command execution injectable for focused error-path tests.
- Run the shared prerequisite check synchronously before each entry point registers package resources; partial package registration is not an acceptable state.
- Remove panel behavior surgically. Extra panel-era columns in an existing SQLite table may remain inert because dropping them would require a destructive migration; new schemas and active code must not create, read, or write them.
- Keep detailed development verification below the user journey or in contributor documentation; it must not displace the root README's what/why/install/run/uninstall flow.
- The package currently has no npm registry release: `https://registry.npmjs.org/%40dpugliese%2Fpi-agent-wave/latest` returned `404` during planning. Re-check immediately before completing the README.
- Pi's local-path install records the source in `settings.json` but does not link package binaries into the shell. Source-install instructions must invoke `scripts/init.mjs`, `scripts/doctor.mjs`, and `scripts/migrate.mjs` through `node`; reserve package bin names for the future npm path.

## Success Metrics

- A new user can follow only root `README.md` to install Herdr, install from the public source repository, initialize pi-agent-wave, start Herdr and Pi, run a delegation, inspect it, and remove the package.
- A fresh-context reader can explain the product and complete the documented journey without needing internal repository or implementation knowledge.
- Loading any package entry point outside Herdr fails with one actionable prerequisite error and registers no package resource.
- No shipped runtime or active user documentation contains a panel fallback path.
- The full Node suite, package-focused Bun suite, typecheck, package dry-run, source install/remove rehearsal, and `git diff --check` pass.

## Verification

- Full Node suite: `166` tests in `27` suites passed with no failures or skips.
- Package-focused Bun suite: `32` tests passed with no failures.
- `npm run typecheck`, `npm pack --dry-run --json --ignore-scripts`, `npm publish --dry-run --json --ignore-scripts`, and `git diff --check` passed.
- The packed artifact contains `46` files, includes `require-herdr.ts`, and excludes `scripts/panel.ts`.
- The real `herdr --version` returned `herdr 0.8.0`; the npm registry endpoint returned `404` immediately before completion.
- The real Pi loader and local-path install/remove rehearsal passed on Pi `0.84.1` and `0.84.2` using temporary agent directories. The rehearsal also proved local installation does not link package bins and direct Node invocation reaches the source CLI.
- Fresh-context Herdr review, semantic synthesis, and post-fix source-command audit found no blocking issues. Evidence ledger: `agent-output/require-herdr-review/delegate-ledger/`; audit result: `PASS: audited 4 ledger files`.

## Open Questions

None. The user selected mandatory load-time Herdr enforcement, complete panel-support removal, official cross-platform Herdr commands, and a working source install with npm clearly marked as unavailable until publication.

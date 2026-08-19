# PRD: Initial configuration for pi-agent-wave

## Overview

Fresh pi-agent-wave installations currently expect `model-routing.jsonc` and `models.json` to exist, but the package provides no user-facing configuration bootstrap. Only tests seed temporary routing files. This feature adds safe standalone initializer and doctor CLIs so a new user can select models per supported tier, create a valid Delegate Graph routing file, optionally create or merge pi-fzf route commands, and diagnose the result without hand-authoring JSONC.

The initializer reads Pi’s existing model catalog. It never creates provider definitions, credentials, or `models.json`.

## Goals

- Provide `pi-agent-wave-init` as a dry-run-first configuration workflow with explicit `apply`.
- Let users select an available model per supported routing tier, with non-interactive flags for automation.
- Generate a routing file that resolves all six Delegate Graph roles and the public policy presets supported by `/delegate`.
- Create or merge pi-fzf `route` and `delegate-model` commands only when pi-fzf is installed, without disturbing unrelated commands.
- Protect existing configuration with fail-closed overwrite behavior, private backups, atomic writes, and byte-exact rollback data.
- Provide `pi-agent-wave-doctor` as a read-only health check with human and JSON output.

## User Stories

### US-001: Discover models and preview an initial routing plan

**Description:** As a new user, I want the initializer to read my existing Pi model catalog and preview a valid per-tier routing plan so that I can configure pi-agent-wave without guessing model identifiers or JSON structure.

**Acceptance Criteria:**

- [x] `pi-agent-wave-init` is declared in `package.json#bin` and defaults to dry-run; proof: `initial-config.test.ts` executes the packed binary against a temporary `PI_CODING_AGENT_DIR` and confirms no files change.
- [x] The initializer reads `models.json` through explicit `--models`, then `PI_MODEL_CATALOG`, then `PI_CODING_AGENT_DIR`, and lists canonical `provider/model` identifiers with available display name and context-window metadata; proof: parameterized catalog tests using the real catalog shape.
- [x] Interactive mode prompts for models for `tools`, `coding`, `test`, `review`, `reasoning`, and `long-context`; `local-fast` is offered only when the catalog contains a loopback provider model. Proof: deterministic stdin/stdout CLI tests.
- [x] Non-interactive mode accepts one explicit model flag per required tier and fails closed when a required selection is missing or absent from the catalog. Proof: `initial-config.test.ts` invalid-input cases.
- [x] Dry-run output contains the target paths, selected models, generated role mappings, pi-fzf action, and validation result without exposing provider credentials or API keys. Proof: output assertions with credential sentinels.

### US-002: Apply and protect the routing configuration

**Description:** As a user, I want explicit apply semantics and reversible overwrite protection so that initialization cannot silently destroy an existing routing setup.

**Acceptance Criteria:**

- [x] `pi-agent-wave-init apply` writes `model-routing.jsonc` atomically with private permissions and preserves the dry-run byte plan. Proof: filesystem mode, hash, and parse assertions in `initial-config.test.ts`.
- [x] The generated file contains tiers for `tools`, `coding`, `test`, `review`, `reasoning`, and `long-context`, plus `local-fast` only when selected; it maps `thinker`, `implementer`, `reviewer`, `tester`, `auditor`, and `searcher` to the verified standard tiers and capability floors. Proof: exact structure assertions.
- [x] Generated defaults are `tools: off/false`, `coding: high/true`, `test: low/false`, `review: xhigh/true`, `reasoning: high/true`, `long-context: medium/true`, and `local-fast: off/false` when present. Proof: exact template assertions.
- [x] Existing `model-routing.jsonc` causes apply to fail without mutation unless `--force` is supplied. `--force` writes a mode-0600 backup outside auto-discovered extension directories before replacement. Proof: byte-exact overwrite and backup tests.
- [x] Invalid catalogs, duplicate or malformed model identifiers, unavailable selections, invalid existing JSON/JSONC, and interrupted writes leave the target unchanged. Proof: failure-path tests.
- [x] Applying the same selections again is idempotent and reports no content change. Proof: repeated-apply hash assertion.

### US-003: Configure optional pi-fzf commands

**Description:** As a pi-fzf user, I want initialization to create or merge route pickers so that `/fzf:route` and `/fzf:delegate-model` work immediately with the installed package.

**Acceptance Criteria:**

- [x] When pi-fzf is registered and `fzf.json` is absent, apply creates a minimal valid file containing `route` and `delegate-model` list, preview, and send actions targeting the installed package’s `route-picker.ts`. Proof: temporary-home integration test executing both commands.
- [x] When `fzf.json` exists, initialization preserves unrelated settings and commands byte-semantically while adding or updating only `route` and `delegate-model`. Proof: merge fixture assertions.
- [x] Existing conflicting `route` or `delegate-model` definitions cause apply to fail unless `--force` is supplied; force mode backs up the original `fzf.json` bytes before merging. Proof: collision and rollback tests.
- [x] When pi-fzf is not installed, the plan reports `skipped` and does not create `fzf.json`. Proof: absent-package test.
- [x] Generated list and preview commands execute successfully and return all Delegate Graph roles from the initialized configuration. Proof: end-to-end subprocess assertions.

### US-004: Diagnose configuration safely

**Description:** As a user, I want a read-only doctor command so that I can understand missing files, invalid routes, unavailable models, and stale picker commands without changing my installation.

**Acceptance Criteria:**

- [x] `pi-agent-wave-doctor` is declared in `package.json#bin`, performs no writes, and supports human output plus `--json`. Proof: before/after tree hashes and schema assertions in `initial-config-doctor.test.ts`.
- [x] Doctor checks agent-directory resolution, model catalog readability, routing JSONC parseability, required tiers and roles, non-empty model chains, catalog membership, optional local-model loopback validity, pi-fzf command targets, package entry points, and real policy-resolver plus route-picker execution. Proof: one focused fixture per diagnostic.
- [x] Doctor exits successfully only when required checks pass; warnings such as absent pi-fzf remain non-fatal, while missing routing, invalid models, or failed resolver execution are fatal. Proof: exit-code matrix.
- [x] Doctor never prints API keys, credentials, or full provider configuration. Proof: credential-sentinel tests.

### US-005: Document and package the onboarding flow

**Description:** As a package user, I want installation documentation and packaged CLIs so that the first-run path is discoverable and reproducible.

**Acceptance Criteria:**

- [x] `README.md` documents dry-run, apply, force/backup behavior, non-interactive tier flags, optional pi-fzf behavior, doctor usage, and recovery. Proof: `package-docs.test.ts`.
- [x] `npm pack --dry-run --json` includes the initializer, doctor, and required package-private helpers while excluding fixtures, credentials, and generated configuration. Proof: `package-artifact.test.ts`.
- [x] The real npm-tarball and loopback-Git installation rehearsal invokes both CLIs from the installed artifact on Pi `0.84.1` and `0.84.2`. Proof: `package-install-rehearsal.test.ts`.
- [x] `npm run typecheck`, the complete Node suite, focused Bun suite, and `git diff --check` pass. Proof: recorded completion commands.

## Functional Requirements

- **FR-1:** The system must ship executable `pi-agent-wave-init` and `pi-agent-wave-doctor` bins owned by the package.
- **FR-2:** The initializer must resolve the agent directory from explicit `--agent-dir`, then `PI_CODING_AGENT_DIR`, then `~/.pi/agent`.
- **FR-3:** The initializer and doctor must resolve routing and catalog paths from explicit flags, then `PI_MODEL_ROUTING` / `PI_MODEL_CATALOG`, then the resolved agent directory.
- **FR-4:** The initializer must read but never create or modify `models.json`, provider definitions, credentials, or authentication state.
- **FR-5:** The initializer must derive selectable model IDs only from `providers.<provider>.models[].id` in the existing catalog and must not invent identifiers.
- **FR-6:** Dry-run must be the default and must perform no writes. `apply` is the only write mode.
- **FR-7:** Interactive selection must cover each supported public tier; non-interactive mode must require explicit tier-model flags.
- **FR-8:** The generated routing template must contain the standard Delegate Graph role, tier, capability-floor, thinking, and session mappings named in US-002.
- **FR-9:** Existing routing or conflicting pi-fzf commands must fail closed unless `--force` is explicit.
- **FR-10:** Force mode must write private, content-addressable backup evidence before any mutation and retain enough data for byte-exact restoration.
- **FR-11:** Writes must be atomic, permissions must be private for routing and backup data, and partial failure must restore the prior state.
- **FR-12:** pi-fzf configuration is conditional on pi-fzf being installed; unrelated commands and settings must remain unchanged.
- **FR-13:** Generated pi-fzf commands must target the initializer package root, not a fixed home, npm-cache, Homebrew, or removed loose-install path.
- **FR-14:** Doctor must be read-only, redact sensitive provider fields, provide stable JSON output, and distinguish fatal errors from optional warnings.
- **FR-15:** Initializer apply must validate the generated routing through the package policy resolver and route picker before committing files.
- **FR-16:** All tests that write configuration must use temporary Pi homes; no development verification may alter the real user installation.

## Non-Goals

- Creating or editing `models.json`, provider endpoints, API keys, OAuth state, or credentials.
- Automatically benchmarking, ranking, or claiming a “best” model.
- Adding a Pi slash-command UI in this slice.
- Replacing `/route` as the post-install role-to-tier adjustment mechanism.
- Managing Herdr installation or configuration.
- Publishing the package, changing repository metadata, or applying initializer writes to the real user installation during development.
- Supporting arbitrary custom role schemas beyond the six Delegate Graph roles in the initial version.

## Design / Technical Considerations

- Reuse `lib/jsonc.mjs`, `lib/model-routing.mjs`, `scripts/policy-resolver.mjs`, and `route-picker.ts`; do not duplicate parsing or policy logic.
- Keep shared path resolution, catalog normalization, routing-template generation, redaction, backup, and atomic-write logic in package-private modules used by both CLIs.
- Use dependency-free terminal prompting so the standalone CLI does not require a running Pi UI. Deterministic stdin/stdout adapters must make prompts testable.
- Preserve the package’s peer-dependency contract and explicit `files` artifact boundary.
- Detect pi-fzf from installed package settings or its installed package path without importing or modifying pi-fzf internals.
- The existing migration utility remains responsible for loose-install migration; initializer backup data uses a separate `migration-backups/pi-agent-wave-init/` namespace.
- Human output may include model names, IDs, and context windows, but JSON and human output must redact credential-bearing fields.

## Success Metrics

- A fresh temporary Pi home with a real `models.json` shape can reach a valid `/route` preview and policy resolution using only documented initializer commands.
- Dry-run and doctor produce identical filesystem hashes before and after execution.
- Apply is idempotent and every overwrite path has a verified byte-exact backup.
- Installed npm and Git artifacts expose working initializer and doctor bins on the tested Pi matrix.
- No credential sentinel appears in CLI output, artifacts, reports, or generated routing.

## Open Questions

- Whether a later release should add a Pi slash command that wraps the standalone initializer.
- Whether future versions should offer curated multi-model fallback-chain suggestions after real benchmarking data exists.

## Verification

Implementation complete. The completion gate recorded:

- `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts` — 157 tests in 26 suites, 0 failures.
- Focused Bun package/companion suite — 25 tests, 0 failures.
- `npm run typecheck` — clean.
- `npm pack --dry-run --json --ignore-scripts` — success; ships `scripts/init.mjs`, `scripts/doctor.mjs`, and the new `lib/` helpers.
- `npm publish --dry-run --json --ignore-scripts` — success (no publication).
- `git diff --check` — clean.
- Real-catalog rehearsal: a copy of the active `models.json` initialized and passed doctor in a temporary Pi home; HF-style slashed local IDs were excluded with warnings while valid models remained selectable.

New artifacts:

- `scripts/init.mjs` (`pi-agent-wave-init`): dry-run-first initializer with explicit `apply`, `rollback`, per-tier non-interactive flags, interactive prompting, fail-closed overwrite protection, private content-addressable backups under `migration-backups/pi-agent-wave-init/`, and pi-fzf merge/create.
- `scripts/doctor.mjs` (`pi-agent-wave-doctor`): read-only health check with human and `--json` output; fatal vs. warning distinction.
- `lib/agent-paths.mjs`, `lib/catalog.mjs`, `lib/routing-template.mjs`, `lib/safe-write.mjs`, `lib/pi-fzf.mjs`: package-private shared helpers reused by both CLIs.
- `test/initial-config-core.test.ts`, `test/initial-config-safety.test.ts`, `test/initial-config.test.ts`, `test/initial-config-doctor.test.ts`.
- `package.json#bin` now also declares `pi-agent-wave-init` and `pi-agent-wave-doctor`.
- `extensions/pi-agent-wave/README.md` documents the onboarding, apply/force/backup, non-interactive, pi-fzf, doctor, and recovery flows.

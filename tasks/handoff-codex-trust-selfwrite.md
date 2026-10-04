# Handoff: every Codex attempt reports a post-settlement failure for its own project-trust entry

**Recorded:** 2026-10-04
**Found by:** the Codex host-service check (`tasks/handoff-host-services.md` §6), then isolated without host services.
**Affects:** every Codex worker on any graph. The candidate is retained; the failure is post-settlement only.
**Not a PRD.** This file is a work order. Read it with `AGENTS.md` (the `settings.json`/`.claude.json` self-write
rule) and `scripts/delegate_core.py:copy_runtime_file`, `verify_provider_links`.

**Status:** opened 2026-10-04. Decision the same day (operator): option 1, which narrows the `AGENTS.md` invariant
that every snapshot except Claude's keeps exact bytes; implemented the same day, every criterion checked below.

## 1. Evidence

| Run | Host services | What happened |
| --- | --- | --- |
| `run_74f0fb3e-4bd2-413d-bf02-a07b102178bb` | browser | Codex escalated after its sandbox refused `node`; `config.toml` snapshot changed |
| `run_58bd8c47-b668-4873-a127-364e560c5e1f` | none | Codex's sandbox refused `node`, no escalation, no retry; `config.toml` snapshot changed |
| `run_122b19d2-27e0-4362-92a3-77a92806f6b0` | none | Attempt copy captured before settlement: 180 → 181 sections, exactly one added, none removed |

The added section is `[projects."<attempt agentfs-home>/.agentfs/run/<session>/mnt"]`: Codex's trust entry for the
directory it runs in, which is a new AgentFS mount for every attempt. The operator's real `~/.codex/config.toml` holds
103 such `projects.*` sections from interactive use and was not modified by any attempt. Each run reports
`runtime configuration snapshot changed: config.toml` and `provider link verification failed: …` in
`postSettlementFailures`; the cleanup audit still passes. Codex CLI `0.154.0`. Evidence:
`agent-output/live-codex-config-selfwrite-20261004/` and
`agent-output/live-host-service-browser-20261004/run3-codex/`. The captured copy itself was deleted, because it held
the operator's whole configuration.

## 2. Why it matters

A post-settlement failure on every Codex attempt is noise that hides real ones: a supervisor learns to ignore the
field. The change Codex makes is confined to the attempt's private copy and never reaches the real file.

## 3. Options

1. **Tolerate exactly this write.** The Codex `config.toml` snapshot accepts an observed file only when, parsed as
   TOML, everything outside `projects` equals the original, every original `projects` entry is unchanged, and each
   added `projects` entry names a directory inside the attempt directory. Any other change, or a file that no
   longer parses, still fails. (Amended at implementation: the plan compared bytes after removing the added tables,
   but how Codex formats an inserted table is not known and the captured copy was deleted, so the comparison is
   structural, against a pristine copy kept in the attempt directory outside `CODEX_HOME`.) Every accepted change is recorded in `configurationSelfWrites`, as for
   Claude.
2. **Pre-seed the trust entry.** Write `[projects."<mount>"] trust_level = "trusted"` into the attempt copy before
   launch, so Codex finds nothing to add. The snapshot keeps exact bytes, but the attempt runs with configuration
   the operator did not write, and the entry's exact form must match what Codex would write, which may change
   between Codex versions.
3. **Leave it and document it.**

Recommendation: option 1, which observes what Codex did instead of predicting it, and keeps every other change a
failure.

## 4. Acceptance criteria (for option 1)

- [x] A Codex `config.toml` snapshot that differs from the original only by one or more added `[projects."<path>"]`
  tables naming directories inside the attempt verifies, and the write is recorded in `configurationSelfWrites`. Proof: a
  test of `verify_provider_links` with real files, red before the change. Evidence: `test/codex-trust-selfwrite.test.ts`
  "trust entries added for directories inside the attempt verify and are recorded" (appended, and inserted between
  tables without a blank line); all 10 cases of the file were red on `e1ac077`.
- [x] Any other change is still refused: a changed existing key, a removed section, or a `projects` table outside the
  attempt, or a file that no longer parses as TOML. Proof: cases in the same test. Evidence: seven "refuses …" cases,
  including an entry escaping the attempt through `..` and a removed existing entry. Mutations: dropping the
  containment check fails both outside-the-attempt cases; dropping the outside-`projects` comparison fails the
  changed-key and removed-section cases.
- [x] Claude's tolerance and every other snapshot are unchanged. Proof: the existing provider-runtime tests pass.
  Evidence: `provider-credential-snapshot.test.ts` and `provider-runtime-config.test.ts` pass unchanged; the wiring case
  shows a Codex attempt's `config.toml` as `codex-trust` and Claude's `settings.json` still `tolerated`. Dropping the
  Codex wiring fails it.
- [x] `AGENTS.md` (the self-write invariant), `specification.md` and the README describe the Codex tolerance.
  Evidence: `AGENTS.md` and `product.md` self-write entries, spec §5.6 (`verify_provider_links` paragraph) and test
  inventory, README "Credentials and configuration".
- [x] One live Codex attempt settles with empty `postSettlementFailures`. Proof: run id and collect result.
  Authorized 2026-10-04. `run_5a50f5c7-cdc0-4657-95f9-0973f3f665f8`, `op_2769672f-6c18-4c15-9110-2c0fa383b369`,
  `openai-codex/gpt-5.6-luna`, no host services: exit 0, settled, `postSettlementFailures` `[]`, cleanup audit
  passed, `configurationSelfWrites` holds `config.toml` with one added `projects."…/.agentfs/run/dg-thinker-0-0-e3a5e5791620/mnt"`
  and nothing removed. The real `~/.codex/config.toml` was unchanged. Codex's own sandbox still refused `node`, the
  separate behaviour `AGENTS.md` records. Evidence: `agent-output/live-codex-config-selfwrite-20261004/run3-after-fix/`.
- [x] Gate green with counts from the run made. 2026-10-04 on `e1ac077` plus this change: 688 tests, 677 passed, 0
  failed, 11 skipped; `git diff --check` clean; typecheck exit 0. Bun package checks not run: `bun` is not installed
  on this host.

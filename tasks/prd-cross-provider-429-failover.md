# PRD: Cross-provider HTTP 429 failover

**Status:** Implemented and verified.

## Overview

pi-agent-wave supports ordered model chains that can contain models from multiple providers, and its failover companion already contains 429 classification and cross-provider candidate-selection behavior. The product does not yet guarantee that an in-flight request—especially a Delegate Graph worker request—survives a provider HTTP 429 by switching to another provider in the same tier.

This feature makes same-tier, cross-provider 429 recovery a dependable product behavior. A delegated worker receives automatic recovery from its frozen route. A main interactive session keeps explicit opt-in control. The interrupted operation is retried after the switch, temporary provider exclusion resets after success, and a transient provider incident does not permanently alter the user’s global default model.

## Goals

- Complete an interrupted model operation when another available and authenticated provider exists later in the same tier route.
- Automatically arm this behavior for Delegate Graph workers from their frozen tier and route.
- Keep main interactive sessions opt-in through the existing failover control.
- Skip every model belonging to the provider that returned the 429 during the current recovery sequence.
- Preserve ordered route preference, explicit locks, graph semantics, privacy, and observable evidence.
- Fail clearly and finitely when no eligible cross-provider model remains.

## User Stories

### US-001: Automatically recover delegated work from a provider 429

**Description:** As a user running delegated work, I want a worker to continue on another provider in the same tier when its active provider returns HTTP 429 so that temporary rate limiting does not fail an otherwise recoverable operation.

**Acceptance Criteria:**

- [x] A Delegate Graph worker with a frozen same-tier route containing `provider-a/model-1`, `provider-a/model-2`, and `provider-b/model-3` automatically switches from `provider-a/model-1` to `provider-b/model-3` after a genuine provider HTTP 429; proof: an end-to-end extension test in `extensions/pi-agent-wave/test/model-failover.test.ts`.
- [x] `provider-a/model-2` is not attempted during that recovery sequence because it belongs to the failing provider; proof: ordered model-selection assertions in `model-failover.test.ts`.
- [x] The interrupted operation is retried after the model switch and produces one accepted result without requiring `/failover enable`; proof: request-attempt and accepted-result assertions in `model-failover.test.ts`.
- [x] Herdr and visible-panel workers receive equivalent automatic failover behavior from the frozen route; proof: transport coverage in `extensions/pi-agent-wave/test/herdr-transport-fallback.test.ts` and `model-failover.test.ts`.

### US-002: Preserve opt-in control for main sessions

**Description:** As a user in a main interactive session, I want failover to remain opt-in so that an intentional model selection is not changed unexpectedly.

**Acceptance Criteria:**

- [x] A main session does not switch models after a 429 until failover has been enabled for a tier; proof: enabled/disabled cases in `model-failover.test.ts`.
- [x] After the user enables failover for a tier, a 429 retries the interrupted request on the next eligible provider from that tier; proof: command-to-recovery integration coverage in `model-failover.test.ts`.
- [x] Manual model selection and explicit model locks suppress automatic failover; proof: lock and manual-selection cases in `model-failover.test.ts`.

### US-003: Scope fallback state to the current session or delegated run

**Description:** As a user, I want temporary failover to remain scoped to the affected session or delegated run so that a short provider incident does not permanently rewrite my global model preference.

**Acceptance Criteria:**

- [x] The fallback model remains active for subsequent operations in the current session or delegated run after successful recovery; proof: consecutive-operation assertions in `model-failover.test.ts`.
- [x] The user’s persisted global default model is byte-identical before and after the failover session; proof: before/after settings evidence in `model-failover.test.ts` using a temporary Pi home.
- [x] Provider exclusion is cleared after a successful response, allowing the provider to be considered in a later independent recovery sequence; proof: success-reset assertions in `model-failover.test.ts`.
- [x] If the selected fallback also returns 429, recovery continues through the ordered route while excluding every provider already failed in that sequence; proof: multi-provider exhaustion coverage in `model-failover.test.ts`.

### US-004: Fail safely when recovery is impossible

**Description:** As a user, I want clear bounded failure when no different provider is usable so that failover cannot loop, silently cross tiers, or hide the actual provider problem.

**Acceptance Criteria:**

- [x] Unavailable or unauthenticated models are skipped while searching the remaining same-tier route; proof: availability and authentication cases in `model-failover.test.ts`.
- [x] When no eligible different-provider model remains, the operation returns a clear route-exhausted blocked result; proof: exhaustion assertions in `model-failover.test.ts`.
- [x] Recovery never selects a model outside the frozen or enabled tier and never loops back to a provider already failed in the current sequence; proof: route-boundary and attempt-bound assertions.
- [x] Exact-model locks, manual locks, semantic failures, invalid requests, refusals, context overflow, and tool failures retain their current non-failover behavior; proof: classification regression coverage in `model-failover.test.ts` and the complete Node suite.

### US-005: Make recovery observable without leaking provider data

**Description:** As a user supervising work, I want to see why a model changed and where execution continued so that automatic recovery remains auditable.

**Acceptance Criteria:**

- [x] Status and evidence identify the source model, destination model, tier, 429 classification, route position, and recovery outcome; proof: status and evidence assertions in `model-failover.test.ts`.
- [x] Generic rate-limit 429 and quota-shaped 429 remain distinguishable in diagnostics while both qualify for cross-provider recovery; proof: classification table in `model-failover.test.ts`.
- [x] Raw provider response bodies, credentials, authorization headers, and API keys never appear in status, evidence, or substituted retry messages; proof: credential and response-body sentinel assertions.
- [x] The real packaged extension loads with this behavior on Pi `0.84.1` and `0.84.2`; proof: `extensions/pi-agent-wave/test/package-install-rehearsal.test.ts`.

## Functional Requirements

- **FR-1:** The system must treat any genuine provider HTTP 429 as eligible for same-tier cross-provider recovery, including generic rate-limit and quota-shaped responses.
- **FR-2:** The system must derive fallback candidates only from the active frozen or explicitly enabled tier’s ordered route.
- **FR-3:** The system must exclude all models belonging to the provider that returned 429 for the duration of the current recovery sequence.
- **FR-4:** The system must select the first remaining model whose provider differs from every provider already failed in the sequence and whose model is available and authenticated.
- **FR-5:** The system must switch models and retry the interrupted operation rather than merely changing the model for a later user request.
- **FR-6:** A recovery sequence must produce at most one accepted operation result and must not duplicate tool execution or graph transitions.
- **FR-7:** Delegate Graph workers must receive automatic failover activation, tier identity, and ordered route from their frozen dispatch policy.
- **FR-8:** Main interactive sessions must remain failover-disabled until explicitly enabled for a tier.
- **FR-9:** Manual selection, manual failover lock, and exact-model lock must prevent automatic switching.
- **FR-10:** A successful fallback must keep the replacement model active for the current session or delegated run without permanently changing the global default model.
- **FR-11:** Temporary failed-provider exclusions must reset after a successful model response.
- **FR-12:** Recovery must continue across distinct providers in route order when successive providers return 429, stopping when one succeeds or the route is exhausted.
- **FR-13:** Exhaustion must fail closed with an observable route-exhausted result and must not promote to another tier.
- **FR-14:** Status and evidence must retain the tier, route position, source model, destination model, 429 category, and final recovery outcome.
- **FR-15:** Failover output must sanitize raw provider bodies and credential-bearing fields.
- **FR-16:** Existing non-429 classification, Delegate Graph topology, evidence gates, and graph-level retry limits must remain unchanged.

## Non-Goals

- Cross-tier promotion or capability-floor changes during recovery.
- Random selection, load balancing, predictive provider health scoring, or proactive traffic shifting.
- Creating or repairing provider credentials, subscriptions, quotas, or authentication.
- Retrying semantic failures, refusals, invalid requests, context overflow, tool errors, or quality-gate failures.
- Ignoring exact-model or manual model locks.
- Permanently blacklisting a provider because of one 429 response.
- Permanently changing the user’s global default model after transient failover.
- Redesigning Delegate Graph topology, joins, review/test gates, or graph-level retry policy.
- Redesigning non-429 runtime failover behavior in this feature.

## Design / Technical Considerations

- The ordered tier route remains the authority for preference and recovery boundaries.
- Launch-time fallback and runtime 429 failover are distinct product behaviors: launch-time fallback handles a model that cannot start, while runtime failover recovers an operation after a started model returns 429.
- Delegate Graph workers have deterministic frozen tier context and therefore receive automatic activation. Main sessions do not have that same supervisory contract and remain opt-in.
- Provider exclusion is sequence-scoped, not permanent. Success clears the exclusion set for a later independent operation.
- Generic rate limiting and quota exhaustion share the same recovery eligibility but retain distinct diagnostics.
- The retry must respect existing request and graph attempt limits so that automatic recovery cannot create an unbounded loop or duplicate accepted work.
- Existing privacy behavior for assistant errors and evidence remains mandatory.

## Success Metrics

- A delegated operation encountering a provider 429 completes successfully whenever an eligible different-provider model remains in the same frozen tier.
- No recovery attempt selects another model from the provider that returned 429.
- Main-session model selection remains unchanged unless failover was explicitly enabled.
- Temporary recovery never changes the global default model after the session or delegated run ends.
- Route exhaustion is finite, explicit, and observable.
- Generic and quota-shaped 429 paths are covered end to end without credential or response-body leakage.
- The complete package test and installation matrix remains green on the supported Pi versions.

## Open Questions

None. The product decisions are confirmed:

- Automatic activation for Delegate Graph workers; main sessions remain opt-in.
- The interrupted operation is retried after switching.
- The fallback remains scoped to the current session or delegated run and does not persist as the global default.
- Failed-provider exclusion resets after a successful response.
- Any genuine provider HTTP 429 qualifies, with generic rate-limit and quota diagnostics kept distinct.

## Verification Record

- `node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts`: 163 passed, 0 failed.
- Focused Node failover and transport tests: 14 passed, 0 failed.
- Package-focused Bun checks: 29 passed, 0 failed.
- Real installation rehearsal loaded the package on Pi `0.84.1` and `0.84.2`: 1 passed, 0 failed.
- `npm run typecheck`, `npm pack --dry-run --json --ignore-scripts`, `npm publish --dry-run --json --ignore-scripts`, and `git diff --check` completed without errors.

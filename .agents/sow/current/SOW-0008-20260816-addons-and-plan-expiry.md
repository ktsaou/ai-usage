# SOW-0008 - Add-on quota and plan expiry

## Status

Status: in-progress

Sub-state: design approved by the user; implementing.

## Requirements

### Purpose

The monitor tells the user whether they can keep working. For one provider it
currently says the opposite of the truth: its plan quota reads 100% used and the
card is red, while the extra usage packs the user bought sit untouched and the
console states plainly that work continues after the plan quota is spent. The
same provider's subscription ends in three days with auto-renewal off, which the
monitor cannot say at all. Both facts are in API responses the daemon already
fetches or can fetch from the same gateway.

### User Request

> alibaba token plan got exhausted and I bought extensions, so I think their API
> probably returns more data which we ignore.

Confirmed by capturing the console's own traffic. Decisions taken: 1A, 2B, 3A, 4A
(see Implications And Decisions).

### Assistant Understanding

Facts (captured live from the console, values verified, identifiers redacted):

- `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/addon/summary` is **never
  called** by the daemon. It returns `remainingCredits`, `totalCredits`,
  `activeCount` and `nearestExpireTime`. At capture time: 2 active packs, 40000
  credits, none used, nearest expiry 2026-09-16 16:00 UTC. The console renders
  this as "Quota Add-on / Extra Usage Packs" and states "You can continue using
  the service after reaching the quota".
- `…/v2/subscription` **is** called, but only `specCode` is read. It also carries
  `remainingDays`, `startTime`, `endTime`, `autoRenewFlag` and `status`. At
  capture: 3 days remaining, ends 2026-08-19 16:00 UTC, auto-renew **false**.
- `codingPlan.queryCodingPlanInstanceInfoV2` **is** called, but only
  `instanceName` is read. It also carries `instanceEndTime`, `remainingDays`,
  `chargeType`, `chargeAmount`, `autoRenewFlag` and `status`.
- `…/v2/reset-card/list` exists and returns an empty list today.
- The token plan no longer has a 5h window at all: the usage endpoint returns
  only `per1Week*`, and the console shows a single 7-day quota. The metric
  disappearing on 2026-08-06 was correct behaviour, not a defect.
- Both new sources answer through the **existing** gateway helper
  (`IntlBroadScopeAspnGateway`), so no new transport is needed. The console's own
  `api.json` actions (`GetTokenPlanAccountDetail`, `GetSeatSubscriptionSummary`)
  were probed and are irrelevant — the first returns account identity, the second
  an empty object — and they reject direct calls with `PostonlyOrTokenError`
  because they require an anti-bot parameter the daemon does not have.

Inferences:

- An exhausted window that another quota backstops must not drive the provider's
  risk, or the monitor reports "blocked" when work continues normally.
- Whether add-on credits survive the plan expiring is **not stated by any API
  response seen**. Nothing in this SOW assumes either way.

Unknowns:

- The request payload `addon/summary` expects. Implemented as `{}`, matching the
  sibling `usage` endpoint in the same service; verified live after deploy.

### Acceptance Criteria

- The token plan card and MCP report the add-on pool with its expiry, sourced
  from `addon/summary`. Verified live against the daemon.
- An exhausted plan window stops driving the provider's risk and stops
  headlining the card while add-on credits remain, and still reports its own
  exhausted state. Verified by unit tests and live output.
- Both Alibaba providers report plan end date, remaining days, auto-renewal and
  status; a plan ending soon without auto-renewal raises the provider's risk.
  Verified by unit tests and live output.
- Prometheus exports the plan deadline and the auto-renewal flag.
- No new storage columns: the new descriptive fields are not persisted.

## Analysis

Sources checked:

- Live console capture on the daemon host (temporary instrumentation, removed
  and verified removed afterwards): raw gateway responses, the console's request
  list on the coding-plan and token-plan routes, and both console `api.json`
  actions.
- `src/providers/alibaba.ts`, `src/providers/common.ts`, `src/risk.ts`,
  `src/server.ts`, `src/mcp-server.ts`, `src/metrics.ts`, `src/dashboard.html`,
  `src/types.ts`.
- `.agents/sow/specs/provider-quota-semantics.md`, SOW-0007.

Current state:

- `fetchAlibabaToken` makes two gateway calls and uses four fields in total.
- `primaryMetric()` (duplicated in `src/server.ts` and `src/dashboard.html`) and
  `computeProviderRisk()` both exclude only `secondary` metrics.
- `ProviderResult` has no place for subscription-level facts.

Risks:

- A wrong request payload for `addon/summary` yields no metric; it must degrade
  to "absent", never to a fabricated zero.
- The backstop rule must be narrow. Suppressing a window that is merely *high*
  would hide the real constraint; only an exhausted one is suppressed.
- Three renderers must agree on which metrics may headline; the rule is already
  duplicated between server and dashboard, and the duplication must stay in step.

## Pre-Implementation Gate

Status: ready

Problem / root-cause model:

- The fetcher was written to answer "how much of the plan quota is left" and
  reads only the fields that answer it. Everything else the vendor returns —
  a second pool of quota, the subscription's own lifetime — is discarded at the
  parse step, so no downstream surface can ever show it. Evidence: the field
  lists above against the four fields currently read.

Evidence reviewed:

- Live captures listed under Sources checked. No external open-source references
  were relevant: this is a vendor console's private API, not a documented one.

Affected contracts and surfaces:

- `UsageMetric` gains `backstopped?` and `expiresAt?`; `ProviderResult` gains
  `subscription?`. Both descriptive, neither stored.
- `src/providers/alibaba.ts` (both providers), `src/providers/common.ts`.
- `src/risk.ts` (binding eligibility, plan-expiry risk), `src/server.ts`
  (`primaryMetric`, payload), `src/dashboard.html` (`primaryMetric`, card),
  `src/mcp-server.ts`, `src/metrics.ts`.
- Spec, AGENTS.md.

Existing patterns to reuse:

- `note` / `breakdown` / `secondary` / `rolling`: descriptive metric fields set
  only by the fetcher, passed through, never stored. `backstopped` and
  `expiresAt` follow exactly that pattern.
- `callGateway()` already handles session recovery, so the new call needs no
  transport work.
- The countdown rendering already keyed on `data-reset` in the dashboard and
  `toRfc3339` + `countdown()` in the MCP.

Risk and blast radius:

- One extra gateway XHR per token-plan poll (three instead of two), once a
  minute. Negligible against a 60s interval.
- Changing headline eligibility affects only providers that set the new flag.
- Plan-expiry thresholds are a judgement call (7 days elevated, 48 hours
  critical, and only when auto-renewal is off); they are stated in the spec so
  they are not re-tuned silently.

Sensitive data handling plan:

- The captured responses contain account, organisation, workspace and instance
  identifiers, and a masked API key. None of it is written to any durable
  artifact: this SOW records field names, semantics and the two quota values that
  matter, with identifiers redacted. Raw captures stay in the session scratchpad.

Implementation plan:

1. `types.ts` + `common.ts`: `backstopped`, `expiresAt`, `SubscriptionInfo` on
   the result.
2. `alibaba.ts`: add-on call and metric; backstop exhausted windows while credits
   remain; subscription info for both providers.
3. `risk.ts`: exclude backstopped from binding; plan-expiry risk folded into the
   provider level.
4. `server.ts` / `dashboard.html`: headline eligibility, payload, card rendering
   of the plan line and expiry countdowns.
5. `mcp-server.ts`, `metrics.ts`.
6. Tests, spec, AGENTS.md.

Validation plan:

- Unit tests: backstopped exclusion from binding and headline; plan-expiry levels
  including the auto-renewal case; expiry rendering inputs.
- Live: deploy, confirm the add-on metric appears with the expected numbers, the
  card headlines the add-on pool while the weekly window shows exhausted, the
  plan line reads three days with auto-renewal off, and `/metrics` carries the
  new series.
- Same-failure scan: other providers whose fetchers discard subscription-level
  fields.

Artifact impact plan:

- AGENTS.md: note the backstop concept alongside the other descriptive fields.
- Specs: add-on endpoint, subscription fields, backstop rule, plan-expiry
  thresholds, new rendering and Prometheus series.
- End-user/operator docs: none exist.
- End-user/operator skills: none exist.
- SOW lifecycle: completed and moved with the implementation commit once the live
  verification passes.

Open-source reference evidence:

- None applicable; the source is a vendor console's private API observed live.

Open decisions:

- All resolved (below).

## Implications And Decisions

1. **Add-on packs** — chosen **A**: a dedicated `addon_credits` metric carrying
   used/total credits and the nearest pack expiry. Rejected B (merging plan and
   add-on into one number: they expire independently and the vendor shows them
   separately) and C (ignore).
2. **Risk when add-ons cover an exhausted window** — chosen **B**: the fetcher
   marks an exhausted window `backstopped` while add-on credits remain, so it no
   longer drives the provider's risk nor headlines the card, while still
   reporting its own exhausted state. Rejected A (leave it binding), which would
   keep shouting "at risk" while work continues normally.
3. **Plan expiry and auto-renewal** — chosen **A**: surface end date, remaining
   days, auto-renewal and status for both Alibaba plans, and raise the provider's
   risk when a plan ends soon with auto-renewal off. Rejected B (ignore).
4. **Reset cards** — chosen **A**: not implemented while the endpoint returns an
   empty list. Parsing an always-empty array is guesswork; revisit with a
   populated sample.

## Plan

1. Types and helpers.
2. Fetcher: add-on, backstop, subscription.
3. Risk model.
4. Renderers: API, dashboard, MCP, Prometheus.
5. Tests, spec, AGENTS.md, deploy, verify, close.

## Execution Log

### 2026-08-16

- Discovery done by temporarily instrumenting the daemon (four cycles: raw
  gateway dump, console resource list, request/response capture, direct call
  attempt), each restoring the original file and restarting the service. Final
  state verified identical to the repository.

## Validation

Pending.

## Outcome

Pending.

## Lessons Extracted

Pending.

## Followup

None yet.

## Regression Log

None yet.

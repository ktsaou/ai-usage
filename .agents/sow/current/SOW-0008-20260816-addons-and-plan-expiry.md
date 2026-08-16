# SOW-0008 - Add-on quota and plan expiry

## Status

Status: completed

Sub-state: implemented, tested, deployed to the daemon host and verified live.

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

- Implemented in the planned order. One design point was settled by a failing
  test rather than by choice: unknown auto-renewal. Treating "unknown" as safe
  would silence a real end date, so anything but a confirmed "it renews" is
  treated as "it does not". The test was wrong, not the code; both now say so.

## Validation

Acceptance criteria evidence (live, after deploy):

- The add-on pool is fetched and reported: `alibaba-token` went from 1 metric per
  poll to 2, confirming `addon/summary` accepts the `{}` payload that was
  inferred from its sibling endpoint. Live values: 0 of 40000 credits used,
  2 active packs, expiry 2026-09-16 16:00 UTC.
- The spent window no longer speaks for the provider: `weekly_quota` reports
  100% and its own `crit`, is flagged `BACKSTOPPED`, and the provider's binding
  metric is `addon_credits`. The card headlines the add-on pool; the weekly
  window renders as a sub-row at 100%.
- Plan facts are live for both providers: the token plan ends 2026-08-19 16:00
  UTC (76h, auto-renew false → `warn`), the coding plan 2026-09-14 16:00 UTC
  (700h, auto-renew true → `ok`). The provider-level risk of `alibaba-token` is
  `warn` from the plan while its binding quota is `ok` — the case the design
  intends — and both the dashboard plan line and the MCP plan line state why.
- Prometheus carries `ai_usage_plan_seconds_remaining` and
  `ai_usage_plan_auto_renew` for both providers (274698s / 0 and 2521098s / 1).
- Expiry renders as expiry, never as a reset: the MCP prints
  `expires 2026-09-16T16:00:00Z (in 31d …)`, the card foot reads `expires in …`,
  and the "next quota reset" tile ignores it.
- The add-on metric's burn rate appeared 11 minutes after its first sample — the
  10-minute minimum span plus a poll — reporting no rate rather than a
  fabricated one until then.
- No schema change: the new fields are descriptive and unstored; `addon_credits`
  is an ordinary metric row.

Tests or equivalent validation:

- `npm test` — 26 tests, all passing. New coverage: a backstopped window is
  excluded from binding while keeping its own critical state; the same window
  without the flag still binds; a plan ending soon outranks healthy quotas;
  plan-expiry levels at 30h/72h/300h with auto-renewal on, off and unknown; a
  non-`VALID` status overriding the dates; and absent subscription data yielding
  none rather than a reassuring default.
- `npx tsc --noEmit` — clean.

Real-use evidence:

- Before deploying, the whole surface was exercised against synthetic data
  shaped like the live account (spent weekly window, untouched packs, plan
  ending in 76h): API payload, `/metrics`, a real MCP session and the dashboard
  in a headless browser.
- After deploying: the live checks listed above, plus a live MCP
  `query_provider` and a screenshot of the running dashboard.

Reviewer findings:

- None; no external review was requested.

Same-failure scan:

- Checked every other fetcher for discarded subscription-level fields: z.ai,
  MiniMax, Kimi, MiMo, DeepSeek and OpenRouter responses carry no plan end date,
  renewal flag or add-on pool, so there is nothing equivalent to surface. Only
  the two Alibaba providers report a subscription.
- Checked every consumer of `resetsAt` for one that would misread `expiresAt`:
  all of them null-guard, and the additions are explicit about which is which.

Sensitive data gate:

- The captured console traffic contains account, organisation, workspace and
  instance identifiers and a masked API key. None of it appears in code, spec,
  AGENTS.md or this SOW: only field names, semantics, the two quota values and
  the dates. Raw captures stayed in the session scratchpad.

Artifact maintenance gate:

- AGENTS.md: updated — `backstopped`/`expiresAt`/`subscription` added to the
  descriptive-fields paragraph, plus the rule that a card contradicting the
  vendor's own console usually means an uncalled endpoint.
- Runtime project skills: none exist; the reusable part of this work (how to
  capture a console's traffic through the daemon) is recorded in AGENTS.md and
  in this SOW's execution log, which is where a future reader will look.
- Specs: updated — add-on endpoint and metric, the backstop rule and why it
  exists, the disappearance of the token plan's 5h window, subscription facts
  and their levels, expiry-versus-reset rendering, the MCP plan line and the new
  Prometheus series.
- End-user/operator docs: none exist in this repository.
- End-user/operator skills: none exist in this repository.
- SOW lifecycle: `Status: completed`, moved to `.agents/sow/done/`, committed
  with the implementation.

Specs update:

- `.agents/sow/specs/provider-quota-semantics.md` — as above.

Project skills update:

- Not needed; see artifact maintenance gate.

End-user/operator docs update:

- None affected.

End-user/operator skills update:

- None affected.

Lessons:

- The monitor was wrong for as long as nobody compared it with the vendor's own
  page. Both facts it was missing were one API call away, and one of them was in
  a response it already fetched and parsed. When a card contradicts the console,
  the data is usually already there.
- Instrumenting the running daemon was the only way to see this: the browser
  session cannot be shared with a second process, and every guess at the
  console's request shape was rejected by its anti-bot check. Letting the page
  make its own calls and reading the responses worked first time.
- An endpoint's name is not its contract: `GetTokenPlanAccountDetail` returns
  account identity, not token plan details. Reading the response beat reasoning
  about the name.
- A test that fails can be the design decision surfacing. Unknown auto-renewal
  had never been considered until the assertion disagreed with the code.

Follow-up mapping:

- Reset cards (`reset-card/list`): rejected for now with evidence — the endpoint
  returns an empty list, and parsing an unseen shape is guesswork. Recorded in
  the spec so the next reader knows it exists.
- Whether add-on credits survive the plan expiring: unknown, and no API response
  says. Not tracked as work; flagged to the user, whose account it is.
- OpenRouter's unshown 87%-of-credits figure remains open from SOW-0007 and is
  unaffected by this change.

## Outcome

Delivered and live. The token plan card now says what is actually true: the plan
quota is spent, 40000 add-on credits remain, and the plan itself ends in three
days without renewing. The exhausted window keeps reporting itself exhausted but
no longer decides the provider's state, so the monitor stops claiming "blocked"
while work continues. Both Alibaba plans report their lifetime, and a plan ending
soon without auto-renewal now raises the provider's risk on its own.

## Lessons Extracted

See Validation → Lessons.

## Followup

- Add-on credits' fate after plan expiry is undocumented by the vendor's API; the
  user was told, since only they can check it against the account.

## Regression Log

None yet.

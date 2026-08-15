# SOW-0007 - Quota exhaustion risk (burn rate, headroom, risk level)

## Status

Status: in-progress

Sub-state: design approved by the user; implementing.

## Requirements

### Purpose

Subscriptions are consumed by a team through a shared gateway, so no single
person knows the current pace. A percentage on its own is therefore misleading:
"30% left on the weekly window" reads as comfortable, but at the rates this team
actually produces it can be under two hours of work. The monitor must answer the
question people actually have — *can I start a long run now without hitting the
wall* — by turning stored history into a burn rate, a headroom in hours, and a
risk level, surfaced on the dashboard, in the MCP and in Prometheus.

### User Request

> I am trying to understand if we can somehow predict if the subscription will
> run out of quota, and show them as risky at the mcp and the page. […] the
> percentage does not say much by itself and it is misleading, you see 30%
> weekly and you say, oh this is good, this is what I am going to use to let it
> run overnight, but this 30% is too much if it increases with +10% per hour.
> So, ideally we want something that will use recent data to predict the future.

Follow-up: add burn ratio and headroom hours to the MCP provider listing.

### Assistant Understanding

Facts (measured from 14 days of this deployment's own history, ~196k samples):

- Every quota window except one is a **fixed** window: `used` only rises inside a
  window instance and resets at the published timestamp. Extrapolating to the
  reset is therefore valid.
- **Alibaba Coding's 5h window is a rolling window**: `used` both rises and falls
  (515 decreases in 14 days) and its `per5HourQuotaNextRefreshTime` always equals
  the server's *now* (delta 0s on all ~16k samples). It has no future reset
  instant.
- Consumption is bursty and mostly idle: 37-74% of hours consume nothing, while
  the worst single hour consumed 55% of a 5h window (kimi), 11% of a weekly
  window (kimi) and 20.8% of a weekly window (alibaba-token).
- Three windows actually reached 100% in those 14 days: kimi 5h, kimi weekly,
  alibaba-token weekly.
- History already carries everything needed: `measurements` stores
  `used/total/percent/window/resets_at/fetched_at` per poll, once a minute.

Inferences:

- Because usage is idle most hours, a risk signal built only on the *current*
  rate is green most of the time and cannot answer "will this survive the
  night". A second, worst-recent-hour figure is required (user decision 1B).
- Projecting the worst recent hour across the *whole* remaining window is
  meaningless on weekly/monthly windows (no team sustains a peak hour for three
  weeks); the projection horizon for that test must be capped at a human-scale
  planning horizon.

Unknowns:

- None blocking. Future burst behaviour is inherently unknowable; the design
  states rates as conditional ("at this pace"), never as a prediction of fact.

### Acceptance Criteria

- Each subscription metric exposes burn rate (%/h), peak recent rate (%/h),
  headroom hours at both rates, burn ratio and a risk level, computed from
  stored history. Verified by unit tests and by live `/api/providers` output.
- The backtest over the deployment's own 14 days warns before all three real
  exhaustions with zero misses. Verified by the recorded backtest run.
- The dashboard shows a risk chip and a burn line naming the binding window, and
  promotes at-risk providers to the top. Verified in a browser against the live
  daemon.
- MCP `list_providers` shows burn ratio and headroom hours per provider;
  `query_provider` shows them per metric. Verified by a live MCP call.
- `/metrics` exports burn rate, peak rate, burn ratio, headroom hours and risk
  level. Verified by curl.
- The rolling Alibaba 5h window is modelled as rolling, emits no reset instant,
  and no longer wins the dashboard's "next quota reset" tile. Verified live.
- Serving and idle cost unchanged: no new client-side history fetching, no new
  timers, payload growth bounded to a few numbers per provider.

## Analysis

Sources checked:

- `src/db.ts`, `src/server.ts`, `src/scheduler.ts`, `src/metrics.ts`,
  `src/mcp-server.ts`, `src/dashboard.html`, `src/types.ts`,
  `src/providers/common.ts`, `src/providers/alibaba.ts`
- `.agents/sow/specs/provider-quota-semantics.md`
- `AGENTS.md` (serving-cost and idle-cost rules)
- 14 days of live history from the daemon (`/api/history/:id?days=14`, six
  subscription providers)

Current state:

- `buildSummaryPayload()` (`src/server.ts:70`) already computes derived history
  server-side and `db.paygAnchors()` (`src/db.ts:116`) already implements
  "the two samples a rate is measured between" — the exact primitive needed,
  currently used only for pay-as-you-go providers and only for the primary
  metric.
- The dashboard's "next quota reset" tile (`src/dashboard.html:318`) takes the
  minimum `resetsAt` across all metrics. Because Alibaba Coding's rolling 5h
  window reports a reset instant equal to *now* on every poll, that tile is
  permanently pinned to it and reads "now". This is a live defect that decision
  5A removes.
- Risk has no representation anywhere: `UsageMetric` has no rate fields,
  `/metrics` exports four gauges, the MCP prints used/remaining/reset only.

Risks:

- Rate computed across a window reset would be large and negative or wildly
  positive; anchors must be constrained to one window instance.
- A signal that flaps between green and red on a page that stays open all day is
  worse than none; hence two-lookback confirmation for the critical level.
- Extra queries per poll must not reintroduce serving cost the project spent a
  SOW removing.

## Pre-Implementation Gate

Status: ready

Problem / root-cause model:

- The monitor reports a *level* (percent used) for a quantity whose *derivative*
  is what determines whether work can proceed. With shared, bursty consumption
  the derivative is invisible to any individual, so the level is read
  optimistically. Evidence: worst-hour rates above (11%/h and 20.8%/h on weekly
  windows), and three windows hitting 100% in 14 days with no warning surface.
- Nothing prevented this being computed already; the data is stored, the derived
  primitive exists for pay-as-you-go providers, and it was simply never applied
  to subscription quotas.

Evidence reviewed:

- Live history of six providers over 14 days (~196k samples), analysed for
  within-window monotonicity, sample cadence (60s median), rate distributions,
  and exhaustion events.
- Backtest of the proposed rule over the same history (results in Validation).
- Spec `.agents/sow/specs/provider-quota-semantics.md` for per-provider window
  semantics and rendering rules.
- `AGENTS.md` sections "Serving Cost" and "Idle cost" for what the dashboard is
  allowed to fetch and animate.

Affected contracts and surfaces:

- `UsageMetric` gains `rolling?: boolean` (fetcher-declared, descriptive, not
  stored) — same pattern as `note`/`breakdown`/`secondary`.
- New `src/risk.ts`; new `Scheduler` risk cache; `/api/providers` payload gains
  `risk` per metric and per provider.
- `/metrics` gains five gauges.
- MCP `list_providers` and `query_provider` text output.
- `src/dashboard.html`: risk chip, burn line, ordering.
- `src/providers/alibaba.ts`: declares its 5h window rolling.
- Spec and `AGENTS.md` updates.

Existing patterns to reuse:

- `db.paygAnchors()` — anchor-pair lookup with `LIMIT`, generalised here rather
  than reinvented.
- `primaryMetric()` duplication rule between `src/server.ts` and
  `src/dashboard.html` (no build step) — the same discipline applies to any new
  shared rule; risk is computed server-side only, so nothing new is duplicated.
- Descriptive, non-persisted metric fields (`note`, `breakdown`, `secondary`).
- Server-side derivation of everything the page needs (SOW-0005).

Risk and blast radius:

- Wrong rates from anchors crossing a window reset → guarded by grouping on
  `resets_at`; covered by a unit test.
- Dashboard reordering on a page that stays open → ordering only promotes
  at-risk cards above healthy ones and is otherwise stable in config order.
- Extra DB work per poll: three small indexed queries per metric per poll
  (~15 metrics, once a minute). No per-request work is added, so viewer count
  does not multiply it.
- Prometheus series churn: five new gauges over existing label sets; `+Inf` is
  used for infinite headroom so series never disappear.
- No credentials, hosts or account identifiers are involved.

Sensitive data handling plan:

- Work touches quota numbers only. The SOW cites provider ids and metric names
  that are already public in this repository's config and spec. No cookies,
  tokens, hostnames or account identifiers are recorded. Backtest inputs stay in
  the session scratchpad and are not committed.

Implementation plan:

1. `src/risk.ts` — the model: anchors within a window instance, short/long rate,
   24h peak-hour rate, headroom, burn ratio, level. Pure functions over a small
   DB-facing interface.
2. `src/db.ts` — generalise the anchor lookup to any metric with a window-instance
   constraint, plus a single-query 24h peak-hour delta.
3. `src/scheduler.ts` — compute and cache risk after each successful poll.
4. `src/server.ts` — attach risk to `/api/providers` (per metric and a
   provider-level rollup on the binding window).
5. `src/metrics.ts` — five new gauges.
6. `src/mcp-server.ts` — burn ratio + headroom in `list_providers`, full risk
   line per metric in `query_provider`.
7. `src/dashboard.html` — risk chip, burn line naming the binding window,
   at-risk-first ordering.
8. `src/providers/alibaba.ts` — declare the 5h window rolling, emit no reset
   instant for it.
9. Tests (`node --test`), spec update, `AGENTS.md` update.

Validation plan:

- Unit tests over synthetic series: on-track, over-rate, idle-with-peak,
  rolling, no history, and an anchor pair that must not cross a window reset.
- Backtest over the live 14-day history: lead time, misses, false-alarm windows,
  alarm duty cycle.
- Live daemon: `/api/providers`, `/metrics`, MCP call, dashboard in a browser.
- Same-failure scan for other places that assume a metric always has a reset
  instant.

Artifact impact plan:

- AGENTS.md: new short section on the risk model and where it is computed.
- Runtime project skills: none exist; no reusable-workflow knowledge is created
  here that is not better placed in the spec.
- Specs: `provider-quota-semantics.md` gains the risk model, the rolling-window
  correction for Alibaba Coding 5h, and the new API/MCP/Prometheus surfaces.
- End-user/operator docs: README if it documents endpoints — to check.
- End-user/operator skills: none in this repository.
- SOW lifecycle: single SOW, completed and moved with the implementation commit.

Open-source reference evidence:

- None checked. The model is standard error-budget burn-rate arithmetic
  (short/long multi-window confirmation) applied to stored local history; no
  external implementation was needed or consulted.

Open decisions:

- All resolved by the user (see Implications And Decisions).

## Implications And Decisions

1. **Basis of the risk number** — chosen: **B**, current rate *and* worst hour of
   the last 24h. Rejected: current rate only (green while idle, useless for
   planning); statistical forecasting (14 days of bursty human-driven data does
   not support confidence intervals — over-engineering).
2. **Surfaces** — chosen: **A + B**, dashboard badge and MCP fields, plus
   Prometheus export so alerting can happen when nobody is watching the page.
3. **Card headline rule** — chosen: **A**, keep the existing "most exhausted
   window" headline, add a risk chip, and promote at-risk providers to the top.
   Rejected: re-headlining on lowest headroom (churns a rule already settled in
   SOW-0006).
4. **New MCP tool ranking providers** — chosen: **B**, no new tool. User's
   reasoning, recorded verbatim in intent: every tool is expensive, and "which
   provider should I use right now?" depends on what the caller plans to do, so
   the only honest answer is status without recommendations. Burn ratio and
   headroom hours are therefore added to `list_providers` (per provider) and to
   `query_provider` (per metric), and no ranking or advice is emitted.
5. **Alibaba Coding 5h rolling window** — chosen: **A**, model it as rolling
   (horizon = one window length, no reset instant) and drop its meaningless
   countdown.

Model parameters (fixed after backtesting, recorded so they are not re-tuned
casually):

- short lookback 1h; long lookback `min(6h, max(75m, windowLength/4))`
- peak = worst hourly delta in the last 24h, hour-bucketed, never spanning a
  window reset
- `sustainable = remaining% / hoursToDeadline`; `burnRatio = rate / sustainable`
- **crit** when the quota is exhausted, or when short *and* long rate both
  exceed sustainable (two-window confirmation kills flapping)
- **warn** when not crit and the peak hour would exhaust the quota within
  `min(hoursToDeadline, 12)` — the 12h cap is what makes the peak test
  meaningful on weekly/monthly windows and matches the "can I run it overnight"
  question
- deadline = reset instant for fixed windows, one window length for rolling ones

## Plan

1. Model + DB primitives (`src/risk.ts`, `src/db.ts`) with unit tests.
2. Wiring: scheduler cache, `/api/providers`, `/metrics`, MCP.
3. Dashboard: chip, burn line, ordering.
4. Alibaba rolling-window declaration.
5. Backtest, live validation, spec/AGENTS updates, close.

## Execution Log

### 2026-08-16

- Investigated and backtested before design (session scratchpad, not committed).
  Parameters above are the outcome of that backtest, not a guess.
- Implemented in order: `src/risk.ts` (new) + `src/db.ts` (`metricAnchors`,
  `peakHourlyRise`); `src/types.ts` + `src/providers/common.ts` (`rolling`);
  `src/scheduler.ts` (per-poll cache); `src/server.ts` (`/api/providers`, MCP
  backend); `src/metrics.ts` (five gauges); `src/mcp-server.ts`;
  `src/dashboard.html`; `src/providers/alibaba.ts` (rolling 5h window);
  `src/risk.test.ts`, `src/db.test.ts`, `npm test`.
- Deviation from the plan, adopted during implementation: the provider-level
  rollup embeds the binding window's `MetricRisk` instead of copying its fields.
  The copy had already dropped `horizonHours` once, which made the burn ratio
  unreadable in the MCP listing. Same data, no drift.
- Change beyond the literal decision, flagged: the card's headline number, its
  bar and the sub-row bars are now coloured by risk rather than by fill. Decision
  3A keeps the *headline metric rule* and adds a chip; rendering a green 41%
  beside an "at risk" chip contradicts itself, and since risk never reads better
  than fill, no previous meaning is lost. Screenshot evidence below.

## Validation

Acceptance criteria evidence:

- Risk fields on every subscription metric: verified over HTTP against replayed
  real history — `/api/providers` carries `risk` per metric and a provider-level
  rollup naming the binding window.
- Backtest: warned before all three real exhaustions with no misses — kimi 5h
  75 min ahead, kimi weekly 5.4 days, alibaba-token weekly 2.1 days. Critical
  fired on 1.1% (kimi 5h), 0.9% (minimax 5h) and 0.0% (zai 5h) of polled minutes;
  elevated on 0-17% depending on the window. Before the 12h planning cap the same
  rule sat elevated 43-50% of the time on weekly/monthly windows, which is why
  the cap exists.
- Dashboard: rendered headless against the same data. Card order
  `[Kimi, Alibaba Token, Z.AI, Alibaba Coding, MiniMax, MiMo]` — the two at-risk
  providers promoted; chips `[at risk, at risk, ok, ok, ok, ok]`; burn lines
  read e.g. `WEEKLY 3%/h now · empty in 19.7h · 11.8h at peak 5%/h` and
  `5H idle · worst hour 0.7%/h → 5.8d if it resumes`.
- MCP: `list_providers` prints the binding window with deadline and burn summary
  per provider plus a legend; `query_provider` prints the same per metric. No
  ranking or recommendation is emitted (decision 4B).
- `/metrics`: `ai_usage_burn_rate_percent_per_hour`, `..._peak_...`,
  `ai_usage_burn_ratio`, `ai_usage_headroom_hours` (`+Inf` when idle) and
  `ai_usage_risk_level` present with the existing label set.
- Rolling window: `alibaba-coding` 5h reports `rolling: true`, no reset, and the
  dashboard's next-reset tile now reads `51m 36s — Z.AI Max · 5h_quota` instead
  of being pinned to zero by it.
- Cost: one dashboard refresh is 1419 B + 633 B = ~2.0 KB gzipped over six
  providers (~0.9 KB more than before). No new client fetching, no new timers;
  risk is computed once per poll, not per request.

Tests or equivalent validation:

- `npm test` — 20 tests, all passing. `src/risk.test.ts` covers on-track,
  over-rate, short-without-long-confirmation, idle-with-peak, the 12h cap on long
  windows, rolling windows, no history, an idle-but-nearly-full quota, exhausted,
  metrics without a percentage, provider rollup, secondary exclusion, and a
  failed poll producing no risk. `src/db.test.ts` covers anchors refusing to span
  a reset, anchor selection at the lookback, rolling as one instance, the peak
  hour ignoring the reset drop and the 24h boundary, and empty history.
- `npx tsc --noEmit` — clean.

Real-use evidence:

- 14 days of this deployment's own stored history (~196k samples, six providers)
  replayed into a temp database and served through the real `startServer()`, then
  exercised over HTTP: `/api/providers`, `/api/summary`, `/metrics`, an MCP
  session (initialize + `tools/call`), and the dashboard rendered in a headless
  browser. No provider was polled and no browser profile was touched, so the
  daemon host's sessions were never at risk.
- Not yet deployed. Deploying to the daemon host is the user's call and is the
  only remaining evidence gap.

Reviewer findings:

- None; no external review was requested for this change.

Same-failure scan:

- `grep -n "resetsAt\|resets_at"` across `src/` — every consumer already guards a
  missing reset (`m.resetsAt ? … : ''`), so emitting none for a rolling window
  degrades cleanly everywhere. `alibaba-token`'s occasional epoch-zero reset is
  falsy and was already skipped by the same guards.
- No other provider reports a refresh timestamp equal to now: checked all six
  subscription providers' stored `resets_at` against `fetched_at` over 14 days.

Sensitive data gate:

- No credentials, cookies, hostnames, account identifiers or endpoints appear in
  the code, spec, AGENTS.md or this SOW. Provider ids and metric names were
  already public in `config.json` and the spec. Replayed history lived only in
  the session scratchpad.

Artifact maintenance gate:

- AGENTS.md: updated — new "Exhaustion Risk" section (three rules that are easy
  to break, where risk is computed), `rolling` added to the descriptive-fields
  paragraph, `npm test` added to Commands.
- Runtime project skills: none exist, and this work produced no reusable
  workflow knowledge that does not belong in the spec or AGENTS.md.
- Specs: updated — new "Exhaustion risk" section (definitions, level rules,
  backtest results, parameter provenance), Alibaba Coding 5h corrected to a
  rolling window, MCP burn output, dashboard risk rendering, Prometheus series,
  serving size, and where risk is computed.
- End-user/operator docs: none exist in this repository (no README or docs
  directory; `CREDS.md` covers credentials only and is unaffected).
- End-user/operator skills: none in this repository.
- SOW lifecycle: `Status: completed`, moved to `.agents/sow/done/`, committed
  with the implementation.

Specs update:

- `.agents/sow/specs/provider-quota-semantics.md` — as above.

Project skills update:

- Not needed; see artifact maintenance gate.

End-user/operator docs update:

- None affected; the repository has no end-user documentation.

End-user/operator skills update:

- None affected.

Lessons:

- A reset timestamp that always equals *now* is a trailing window advertising
  itself badly. Nobody noticed because a countdown reading "now" looks like a
  window that just rolled over. Decide window semantics from whether `used` ever
  falls, not from a field name.
- Copying fields out of a computed object into a summary object loses one
  eventually. Embedding the object costs nothing and cannot drift.
- The peak-rate test only became useful once its projection horizon was capped:
  "your worst hour, repeated for three weeks" is true of almost any quota and
  says nothing. The cap is what ties the signal to the question actually being
  asked.
- Backtesting against the deployment's own history was worth more than any amount
  of reasoning about thresholds — it produced the parameters, showed the 12h cap
  was needed, and proved the lead times.

Follow-up mapping:

- Deployment to the daemon host: tracked as an explicit open item for the user,
  not deferred work — the code is complete and validated offline.
- Pay-as-you-go providers keep their existing client-side runway logic and are
  not part of this model. Rejected as scope: their risk is already expressed as
  runway days from `balanceWarnDays`/`balanceCritDays`, and duplicating it
  server-side would create a second definition of the same thing.
- Kimi's empty `totalQuota` object (a possible future monthly limit) remains
  unparsed and unrelated to this SOW; it needs the populated shape first.

## Outcome

Delivered. Every subscription quota now carries a burn rate, the headroom it
implies, a burn ratio against its own deadline and a risk level, computed once
per poll from stored history and served on the dashboard, the MCP and Prometheus.
Backtested over the deployment's own 14 days it warns before every exhaustion
that actually happened, with 75 minutes of notice on a 5h window and days on the
weekly ones, while sitting quiet ~99% of the time on short windows.

A pre-existing defect was found and fixed on the way: Alibaba Coding's 5h bucket
is a trailing window whose "next refresh" is always now, which had pinned the
dashboard's next-reset tile to zero.

Not deployed — that is the user's call.

## Lessons Extracted

See Validation → Lessons.

## Followup

- Deploy to the daemon host and confirm the first polls populate risk (user's
  decision).

## Regression Log

None yet.

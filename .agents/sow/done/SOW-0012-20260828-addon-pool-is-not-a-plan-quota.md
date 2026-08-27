# SOW-0012 - An exhausted extra-pack pool reports a healthy plan as at risk

## Status

Status: completed

Sub-state: implemented, deployed, verified live.

## Requirements

### Purpose

The monitor exists to answer one question per provider: will this subscription
stop working before its quota resets? A verdict it gets wrong is worse than no
verdict, because the user acts on it. Alibaba Token Pro is currently reported
`at risk` while the plan is working perfectly.

### User Request

> alibaba token plan has addon credits which are expired and weekly quota which
> is not. However the dashboard, and probably the mcp present this wrongly, they
> believe that the subscription is at risk/down because of this, but the
> subscription works perfectly. Actually addon credits 100% means nothing. The
> moment this is full, it should become the same as non-existing.

### Assistant Understanding

Facts, from the live daemon and 21 days of stored history:

- `alibaba-token` reports provider level `crit` with binding metric
  `addon_credits`. Its own plan window, `weekly_quota`, is at 3.15% used with a
  reset 6.7 days away and level `warn`.
- `addon_credits` is `used 100000 / total 100000`, `remaining 0`, `percent 100`,
  `window null`, `resetsAt null`, `coversUntil null`, `horizonHours null`.
- `computeMetricRisk()` sets `level = "crit"` for it through the
  `remaining <= 0` branch (`src/risk.ts:155`), unconditionally — the branch does
  not ask whether the metric has a deadline. `computeProviderRisk()` then picks
  it as the binding window because `crit` outranks the plan window's `warn`
  (`src/risk.ts:256-272`).
- History shows the pool was genuinely consumed, not mis-parsed: pool size went
  `40000` (2026-08-16) to `100000` (2026-08-18), and `remaining` fell to 0 at
  2026-08-23T03:01Z.
- Every threshold the pool crossed (70%, 90%, 100%) was crossed **while the
  plan's weekly window was already spent**, so the pool was correctly the
  binding constraint at the time. The false verdict began at the weekly reset,
  2026-08-27T13:38Z, and has stood for 8.0 hours across 466 polls: the pool
  stays empty while the plan pays again.
- The same wrong verdict reaches the MCP: `list_providers` prints
  `${p.risk.metric}: ${burnSummary(p.risk.binding)}` (`src/mcp-server.ts:158`),
  which resolves to `addon_credits ... risk at risk`.
- The pool's `nearestExpireTime` is 2026-09-16, ~20 days in the future, and
  `activeCount` is 5. The vendor therefore reports five packs still active with
  zero credits left.

Inferences:

- The user's word "expired" describes the pool being used up. The vendor's own
  expiry field disagrees, and this does not change the fix: with `remaining` at
  zero the pool supplies nothing either way.
- The defect is not the arithmetic. `remaining 0` is true. The defect is that a
  reserve pool is being judged by the rules for a plan quota.

Unknowns:

- Whether the vendor's console shows these packs as expired or as spent. Not
  resolvable without driving the shared browser session from a second machine,
  which would end the daemon's production session. It does not gate the work.

### Acceptance Criteria

- With the pool empty and the plan window healthy, `alibaba-token` reports the
  plan window as its binding metric and its level, not the pool. Verified live
  against the deployed daemon.
- An exhausted pool contributes no metric at all: it is absent from
  `/api/providers`, the dashboard card, `/metrics` and the MCP. Verified live.
- A pool holding credits while no plan window is spent is reported, but never
  headlines a card and never sets the provider's level. Verified by unit test.
- A pool that is covering a spent plan window keeps the behaviour SOW-0009
  built: it binds, it is judged against `coversUntil`, and it can be `crit`.
  Verified by unit test.
- The dashboard card and the MCP both describe the plan window. Verified live.

## Analysis

Sources checked:

- `src/providers/alibaba.ts:217-294` - `fetchAlibabaToken`, add-on parsing.
- `src/risk.ts:113-190` - `computeMetricRisk`; `:236-281` - `computeProviderRisk`.
- `src/mcp-server.ts:140-215` - provider and metric rendering.
- `src/dashboard.html:279-300` - `headlineMetric` / `primaryMetric`; `:504` -
  sub-metric rows.
- `src/server.ts:87` - `primaryMetric`.
- `.agents/sow/specs/provider-quota-semantics.md:175-210` - Alibaba Token Plan.
- `.agents/sow/done/SOW-0008-20260816-addons-and-plan-expiry.md`,
  `.agents/sow/done/SOW-0009-20260818-backstop-pool-deadline.md`.
- Live `/api/providers` and `/api/history/alibaba-token?days=21` (39326 samples).

Current state:

- SOW-0008 introduced `addon_credits` as an ordinary eligible metric and
  recorded "The card headlines the add-on pool" as the intended outcome. That
  was correct for the state it was built in — the plan window was spent and the
  packs were paying. Neither SOW-0008 nor SOW-0009 considered the state after
  the covered window resets, which is the state the provider has been in since
  2026-08-27T13:38Z.

Risks:

- Suppressing the pool too broadly would undo SOW-0009 and lose the one warning
  the packs exist to give: that they run out before the window they cover
  resets.

Relationship to earlier SOWs:

- Not filed as a regression. SOW-0008 and SOW-0009 both still do what they
  claimed within the state they addressed; the failing state was never in their
  scope. This SOW adds the missing rule rather than repairing a broken one.

## Pre-Implementation Gate

Status: ready

Problem / root-cause model:

- The extra packs are a **reserve**, not a quota. A reserve constrains the plan
  only while it is the thing paying — while a plan window is spent and the packs
  are covering it. The fetcher emits it unconditionally as an ordinary metric,
  so the risk model, which has no way to know what it is, applies plan-quota
  rules to it: `remaining <= 0` means `crit`, and fullness means elevated. Both
  are meaningless for a reserve that nothing is drawing on.
- Evidence: `src/risk.ts:155` fires on `remaining <= 0` with no deadline test;
  `src/providers/alibaba.ts:267-279` emits the metric whenever `totalCredits > 0`
  and marks it `secondary` never.

Evidence reviewed:

- Live provider payload and 21 days of stored samples, as quoted under Facts.
- Existing `secondary` precedent: `src/providers/fetch.ts:44-52` flags z.ai's
  `monthly_mcp` because it counts hosted tool calls, not model usage; the risk
  model excludes such metrics at `src/risk.ts:256`, and both renderers mirror
  that filter.
- `AGENTS.md`: "`secondary` means 'this measures something other than the plan's
  usage' ... Only the fetcher knows either, so renderers must never special-case
  a metric name to decide it."

Affected contracts and surfaces:

- `src/providers/alibaba.ts` - the only file whose behaviour changes.
- Consumers that observe the change without being edited: `/api/providers`,
  `/api/summary`, `/metrics`, the dashboard card, the MCP.
- `.agents/sow/specs/provider-quota-semantics.md` - the Alibaba Token Plan
  section states the current, now-incomplete rule.
- `AGENTS.md` - the paragraph on `secondary` / `backstopped` gains the reserve
  rule.
- Prometheus: the `addon_credits` series disappears while the pool is empty.
  No alerting is known to consume it; the same already happens for any window
  whose total is absent, which the spec documents.

Existing patterns to reuse:

- `secondary` for a metric that does not measure plan usage, exactly as z.ai's
  `monthly_mcp` uses it. No new flag, no risk-model change.
- Metrics whose total is absent or `<= 0` are already skipped rather than
  emitted as zero, so omitting an empty pool is the established convention.
- `metric()` in `src/providers/common.ts` for construction.

Risk and blast radius:

- Confined to one provider's fetcher. The failure mode of getting it wrong is a
  missed warning while the packs are covering a spent window, which the unit
  tests pin down.
- No schema, storage or endpoint change. The flags involved are descriptive and
  never persisted.
- A blanket risk-model rule ("a metric with no deadline can never be at risk")
  was considered and rejected: `openrouter`'s `credits` metric also has no
  deadline (`window: "lifetime"`, `horizonHours: null`) and is its binding
  metric, where fullness *is* the signal — a prepaid balance at 95% spent must
  still raise. The distinction between a reserve and a balance is a per-provider
  fact, which is why it belongs in the fetcher.

Sensitive data handling plan:

- No credentials, cookies, hosts or account identifiers are involved. Evidence
  quoted here is quota arithmetic, metric names and timestamps. The deployment
  host is referenced only as "the daemon host" and is read from `.env` at run
  time, never written down.

Implementation plan:

1. `src/providers/alibaba.ts`: extract the pool's construction into an exported
   pure function `addonPoolMetric(addon, planMetrics)` that returns the metric
   or `null`, encoding the whole matrix — absent when it has no credits,
   `secondary` when nothing is drawing on it, binding with `coversUntil` when it
   covers a spent window. Derive the covered windows from the plan metrics
   already built, removing the `bridgeUntil` bookkeeping the loop threads today.
2. `src/providers.test.ts`: unit tests for the four states.
3. Spec and AGENTS.md updates.
4. Deploy and verify live.

Validation plan:

- `npm test` (node --test) including the new cases; `npx tsc --noEmit`.
- Live verification after deploy: provider level, binding metric, absence of the
  pool from `/api/providers` and `/metrics`, dashboard card, MCP output.
- Same-failure scan for other metrics with no deadline, and for other reserve
  pools.

Artifact impact plan:

- AGENTS.md: update - the reserve rule belongs with the `secondary` /
  `backstopped` paragraph.
- Runtime project skills: none exist (SOW-0001).
- Specs: update `provider-quota-semantics.md`, Alibaba Token Plan section.
- End-user/operator docs: none exist in this repository.
- End-user/operator skills: none exist.
- SOW lifecycle: single SOW, closed with the work in one commit.

Open-source reference evidence:

- None checked. The work is a semantic rule about one vendor's own billing
  fields, with no external reference implementation to consult.

Open decisions:

- Decisions 1-3 below are recorded as taken. They follow directly from the
  user's instruction that a full pool "should become the same as non-existing";
  none of them leaves a defensible alternative that the user has not already
  ruled out.

## Implications And Decisions

1. **What an exhausted pool should do.** Options: (a) keep emitting it and stop
   it setting the provider's level; (b) do not emit it at all.
   **Selected: (b)**, as the user asked. Under (a) the card keeps a permanent
   red 100% row, because the sub-row's colour comes from the metric's own risk
   level and `remaining <= 0` is `crit` — the card would still say something is
   wrong on a healthy plan. An empty reserve supplies nothing and is
   informationally identical to owning no packs.
   *Implication*: the `addon_credits` series stops being written and stops being
   exported while the pool is empty, and resumes when it is topped up.

2. **A pool that holds credits while no plan window is spent.** Options: (a)
   leave it eligible, as today; (b) mark it `secondary` so it is reported but
   never speaks for the provider.
   **Selected: (b).** This is the same rule as decision 1, one step earlier:
   the user's point is that the pool's fill level says nothing about whether the
   plan works. Under (a) a reserve at 70% would make a healthy provider amber
   and at 90% make it red, purely from fullness, because a pool with no deadline
   is not judgeable and falls back to its fill level (`src/risk.ts:159`). That
   state has not occurred in the stored history — every threshold this pool
   crossed was crossed while the plan window was already spent — so this is a
   latent instance of the reported bug, fixed with it rather than left to
   surface later.
   *Implication*: the pool still appears on the card with its numbers, note and
   expiry, and still carries its own risk figures; it just cannot headline or
   set the level.

3. **A pool that is covering a spent plan window.** Unchanged from SOW-0009: it
   is eligible, binds, carries `coversUntil`, and is `crit` when it will not
   last until the covered window resets. This is the one state where the packs
   are the constraint, and the only warning they exist to give.

4. **Where the rule lives.** Options: (a) the risk model; (b) the fetcher.
   **Selected: (b).** A risk-model rule would have to be "a metric with no
   deadline can never be at risk", which is wrong for `openrouter`'s `credits`
   — no deadline either, but its fullness is exactly the signal. Reserve versus
   balance is a per-provider fact, and AGENTS.md already records that only the
   fetcher can know it.

## Plan

1. Pure `addonPoolMetric()` in `src/providers/alibaba.ts`, encoding the matrix.
2. Unit tests for the four states.
3. Spec and AGENTS.md.
4. Deploy, verify live, close.

## Execution Log

### 2026-08-28

- Reproduced from the live daemon and 21 days of stored history before changing
  code: provider `crit` on `addon_credits`, plan window at 3.15% used.
- `src/providers/alibaba.ts`: added `addonPoolMetric()`, which decides the pool's
  three states, and removed the `bridgeUntil` bookkeeping the window loop carried
  — what the packs cover is now read off the plan metrics' own `backstopped`
  flags and reset times.
- `src/providers.test.ts`: new, six cases covering the pool's states and their
  effect on the provider's risk.
- Found while verifying, and fixed in scope: `/metrics` was exporting metrics
  that no longer exist. `db.allLatest()` took the newest row per *metric name*,
  so a metric a provider stops reporting keeps its last value forever. Two series
  were affected — the now-omitted `addon_credits`, and `alibaba-token`'s
  `5h_quota`, frozen since the vendor withdrew that window on 2026-08-06, 22 days.
  The query now takes each provider's newest poll and returns the metrics stored
  under it. `src/db.ts`, `src/db.test.ts`.
- Deployed twice (once per change) from a staging copy of the working tree, so
  the daemon host's own checkout stayed clean until the commit landed.

## Validation

Acceptance criteria evidence:

- Plan window speaks for the provider: live `/api/providers` reports
  `alibaba-token` `level=warn`, `binding=weekly_quota`. Before: `level=crit`,
  `binding=addon_credits`.
- Exhausted pool contributes nothing: `lastFetch.metrics` is `[weekly_quota]`;
  `/metrics` carries no `addon_credits` series; the dashboard card has no
  sub-rows; `query_provider alibaba-token` lists one metric.
- A held reserve never headlines or sets the level: `src/providers.test.ts`,
  "a held reserve cannot make a healthy provider look elevated" — the pool's own
  reading stays `crit` while the provider is `ok` and bound to the plan window.
- A covering pool keeps SOW-0009's behaviour: `src/providers.test.ts`, "a pack
  pool covering a spent window binds, and inherits that window's reset" —
  `secondary` unset, `coversUntil` equal to the soonest covered window's reset.
- Both surfaces describe the plan window: dashboard card reads
  `ELEVATED / 3.2% / WEEKLY 0.2%/h now · empty in 17d 17h · 2d 15h at peak
  1.5%/h / resets in 6d 15h`; MCP `list_providers` reads
  `weekly_quota (resets in 6d 15h): risk elevated · burn 0.2%/h …`.

Tests or equivalent validation:

- `npm test` — 51 pass, 0 fail (43 before this SOW; 6 provider cases and 2
  exporter cases added).
- `npx tsc --noEmit` — clean.

Real-use evidence:

- Deployed to the daemon host; service `active`, all eight providers `state=ok`.
- Live `/api/providers`, `/api/summary`, `/metrics`, the MCP over its HTTP
  transport, and a headless render of the dashboard were each read after the
  deploy. `/api/summary` charts `weekly_quota` with 121 points, 5864 bytes.
- The card invariant from SOW-0010 still holds on all eight cards: one headline
  window plus one row per other window, none repeated.

Reviewer findings:

- No external review requested.
- The frozen-series defect was found while verifying this change, not reported.
  It is fixed here rather than tracked because omitting a metric is what exposes
  it: without the fix this SOW would have replaced a wrong verdict on two
  surfaces with a wrong figure on a third.

Same-failure scan:

- Other reserve-style pools: none. Every other deadline-less metric is a
  pay-as-you-go balance — `openrouter/credits`, `deepseek/balance_usd` and
  `topped_up_usd` — where fullness is the signal, not a reserve level. The two
  DeepSeek metrics carry `percent: null` and get no risk at all.
- Other consumers of a metric that stops being reported: `db.allLatest()` was
  the only one. `/api/providers`, `/api/summary` and the dashboard read the
  scheduler's live result; `db.sparkline()` and `db.metricAnchors()` are called
  only for metrics present in that result.
- Other callers of `allLatest()`: `src/metrics.ts:16` only.

Sensitive data gate:

- No secrets, credentials, cookies, hosts or account identifiers in the change or
  in this SOW. Evidence is quota arithmetic, metric names and timestamps; the
  deployment target is referred to as "the daemon host" and is read from `.env`
  at run time.

Artifact maintenance gate:

- AGENTS.md: updated — the reserve rule added beside the `secondary` /
  `backstopped` paragraph, and the deadline paragraph corrected. It claimed "a
  quota with no deadline at all can never be reported as at risk", which the code
  has never done: such a quota falls back to its fill level, which is how an
  empty pool reached `crit` in the first place.
- Runtime project skills: none exist (SOW-0001).
- Specs: updated — `provider-quota-semantics.md`, the Alibaba Token Plan section
  (the pool's three states) and the serving section (the exported snapshot).
- End-user/operator docs: none exist in this repository.
- End-user/operator skills: none exist.
- SOW lifecycle: `Status: completed`, moved to `.agents/sow/done/`, committed
  with the work in one commit.

Specs update:

- Done, as above.

Project skills update:

- Not applicable — this repository has no `.agents/skills/project-*/` skills
  (SOW-0001).

End-user/operator docs update:

- Not applicable — none exist.

End-user/operator skills update:

- Not applicable — none exist.

Lessons:

- A quota and a reserve look identical to a risk model, and only the fetcher can
  tell them apart. The model's fallbacks — nothing left means at risk, nearly
  full means elevated — are right for something the plan spends and meaningless
  for something held behind it.
- The bug was invisible for as long as the pool was covering a spent window,
  which is the state it was built and reviewed in. SOW-0008 and SOW-0009 were
  both correct about the state in front of them; neither asked what the metric
  would say after the window it covered reset. When a metric's meaning depends
  on another metric's state, every combination is a case, not just the one on
  screen.
- Removing a metric is not a local change. `/metrics` served the last value of
  every metric name ever stored, so omitting one would have frozen it instead of
  removing it — and the same query was already serving a window that had not
  existed for 22 days. What a change stops producing has to be traced as
  carefully as what it starts producing.

Follow-up mapping:

- Reserve rule: implemented.
- Frozen exported series: implemented.
- The vendor reports five packs "active" with an expiry 20 days out and zero
  credits remaining. The monitor no longer depends on which reading is right —
  either way the pool supplies nothing — so nothing is tracked. If the user wants
  the pool's expiry surfaced while it still holds credits, that is a new request.
- No deferred items. Scan of this file for `defer|later|follow-up|future|TODO|pending`
  returns only this section's heading and the word "pending" inside quoted
  template text.

## Outcome

An extra-pack pool is reported as what it is: a reserve behind the plan, not a
quota of its own. It is omitted entirely once its credits are gone, reported but
never able to speak for the provider while it holds credits nobody is drawing on,
and judged exactly as SOW-0009 built it while it is covering a spent plan window.
Alibaba Token Pro now reports its weekly quota — 3.2% used, elevated, resetting in
6d 15h — on the dashboard, in the MCP and in Prometheus, instead of declaring a
working subscription at risk because a pool it is not using is empty.

Separately, `/metrics` no longer exports metrics a provider has stopped
reporting. It now serves each provider's most recent poll, which removed a
`5h_quota` series frozen for 22 days as well as the spent pool.

## Lessons Extracted

Recorded in Validation > Lessons. The two durable ones are carried into
AGENTS.md: that a reserve is only a constraint while it is paying, and that a
metric with no deadline falls back to its fill level, which suits a balance and
not a reserve.

## Followup

None.

## Regression Log

None yet.

Append regression entries here only after this SOW was completed or closed and
later testing or use found broken behavior. Use a dated
`## Regression - YYYY-MM-DD` heading at the end of the file. Never prepend
regression content above the original SOW narrative.

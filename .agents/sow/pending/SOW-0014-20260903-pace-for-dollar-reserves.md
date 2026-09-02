# SOW-0014 - Judge dollar-denominated reserves by pace

## Status

Status: open

Sub-state: waiting for a real observation — a positive xAI prepaid balance has not been seen yet.

## Requirements

### Purpose

Warn when a reserve that is paying for a spent window will not last until that window resets, for reserves the vendor reports as a remaining amount of money with no total — today the xAI SuperGrok prepaid credits (`prepaid_credits`, USD).

### User Request

Decision 6A of SOW-0013: prepaid credits are shown as a dollar balance and never judged by pace; pace judgment for dollar reserves is tracked separately, to be designed once a positive balance has been observed.

### Assistant Understanding

Facts:

- The risk model measures burn in percent of a quota per hour (`src/risk.ts`), and `db.metricAnchors()` / `db.peakHourlyRise()` read the `percent` column. A metric with `percent: null` gets no `MetricRisk` and can never bind.
- Alibaba's extra packs are judged because the vendor reports `totalCredits` and `remainingCredits`, so the pool has a percent. xAI reports only `prepaidBalance` (remaining cents), never what was bought.
- With SOW-0013 as shipped, a spent week with credits left reports the provider `ok` with no binding window (`risk.metric: null`); the dashboard headlines the dollar row through `primaryMetric()`'s fallback, the MCP prints the balance form.

Inferences:

- A denominator has to come from history: the balance at the moment the reserve started paying (the first sample after the covered window reached 100%), or the highest balance seen in the current covered period. Either needs a query over stored samples and a rule for top-ups mid-period.
- Alternatively the model could accept a rate in the metric's own unit when `percent` is null but `remaining` is finite: headroom = remaining / rate, sustainable = remaining / horizon, burn ratio unchanged. That is a change to the backtested model and to the stored-value column the anchors read.

Unknowns:

- Whether `prepaidBalance` decreases continuously while the week sits at 100 %, or in coarse steps; whether `creditUsagePercent` stays at 100 or is reset when credits are drawn. Both need a real drawdown to observe.

### Acceptance Criteria

- A positive prepaid balance covering a spent weekly window is judged against `coversUntil` with a burn rate, headroom and burn ratio, on the dashboard, the MCP and `/metrics`.
- The backtest in the risk spec is re-run, or a reason recorded why the parameters are unaffected.
- SOW-0013's spec section is updated to remove the "never judged by pace" limitation.

## Analysis

Sources checked:

- SOW-0013 (`.agents/sow/done/`), `src/risk.ts`, `src/db.ts`, `src/providers/xai.ts`, `.agents/sow/specs/provider-quota-semantics.md` (xAI section).

Current state:

- Not started. Blocked on observing a real drawdown; do not design the denominator from guesses about the payload.

Risks:

- Choosing a denominator from history makes the pool's percent depend on when the daemon started watching; the rule must say what it means after a restart and after a top-up.

## Pre-Implementation Gate

Status: blocked

Problem / root-cause model:

- To be filled once a positive balance and its drawdown have been observed; see Unknowns.

Evidence reviewed:

- Pending.

Affected contracts and surfaces:

- `src/risk.ts`, `src/db.ts` (anchor and peak queries), `src/providers/xai.ts`, the risk section of the spec, `src/xai.test.ts`, `src/risk.test.ts`.

Existing patterns to reuse:

- `coversUntil` / `bridging` handling in `computeMetricRisk()`; `addonPoolMetric()` for the reserve states.

Risk and blast radius:

- Model change affecting every provider's risk if done in `risk.ts`; must be re-backtested.

Sensitive data handling plan:

- Observations are recorded as field names and numbers only.

Implementation plan:

1. Pending observation.

Validation plan:

- Pending.

Artifact impact plan:

- AGENTS.md: the "quota with no deadline" paragraph may need the dollar-reserve case.
- Runtime project skills: none exist.
- Specs: xAI section and exhaustion-risk section.
- End-user/operator docs: none expected.
- End-user/operator skills: none exist.
- SOW lifecycle: follow-up of SOW-0013.

Open-source reference evidence:

- xAI's own client warns on absolute thresholds only (credits ≤ $10 when auto top-up is off), never by pace: `xai-org/grok-build @ 72a61251fcff`, `crates/codegen/xai-grok-pager/src/views/credit_bar.rs:145-232`.

Open decisions:

- Denominator source (balance when the reserve started paying vs. highest balance in the covered period vs. a unit-agnostic rate in the model) — needs the observation first.

## Implications And Decisions

Pending.

## Plan

Pending.

## Execution Log

### 2026-09-03

- Created as the follow-up of SOW-0013 decision 6A.

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

Append regression entries here only after this SOW was completed or closed and later testing or use found broken behavior. Use a dated `## Regression - YYYY-MM-DD` heading at the end of the file. Never prepend regression content above the original SOW narrative.

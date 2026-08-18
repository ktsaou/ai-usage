# SOW-0009 - A backstop pool is judged against the window it covers

## Status

Status: completed

Sub-state: implemented, tested, deployed and verified live.

## Requirements

### Purpose

The monitor exists to say whether work can continue. It reported the Alibaba
token plan as healthy while the pool actually paying for that work was 24 hours
from empty, because the pool had no deadline to be measured against.

### User Request

> alibaba token plan addon credits says: Addon Credits 2.2%/h now · empty in 1d
> 1h / Plan ends in 1d 7h. But it is not at risk. Why?

and, correcting the assistant's proposed fix:

> addon credits of the alibaba need to provide enough for the weekly quota to
> reset. So, the weekly quota has been extended with addon credits because it got
> exhausted, so the key condition is "do we have enough addon credits for the
> weekly quota to reset?"

### Assistant Understanding

Facts:

- Every level in the risk model is computed against a deadline: `sustainable =
  remaining% / hoursToDeadline`, `burnRatio = rate / sustainable`. The deadline
  came from `resetsAt`, or from the window length for a rolling window.
- `addon_credits` has neither, so `horizonHours` was `null`, `sustainable` and
  `burnRatio` were `null`, and both the crit and the warn branch were
  unreachable. The level fell back to the raw fill level. Live evidence at the
  time of the report: `percent=43.26 horizonH=None burnRatio=None level=ok` with
  `headroomHours=24.65` and a rate of 2.3%/h.
- The packs are drawn on **only because** a plan window is spent, and stop being
  the constraint the moment that window resets.

Inferences:

- Therefore the pool's deadline is the covered window's reset, and no new
  thresholds are needed: the existing rule applies unchanged.

Unknowns:

- None. The user settled the semantics.

### Acceptance Criteria

- A pool covering a spent window is critical when it runs out before that window
  resets, and ok when it comfortably outlasts it. Verified by unit tests and live.
- Surfaces never call that deadline a reset of the pool.
- A pool covering nothing keeps having no deadline. Verified by unit test.

## Analysis

Sources checked: `src/risk.ts`, `src/providers/alibaba.ts`, `src/types.ts`,
`src/mcp-server.ts`, `src/dashboard.html`, the spec, SOW-0007 and SOW-0008, and
the live `/api/providers` payload.

Current state: `computeMetricRisk()` derived `horizonMs` from `rolling` and
`resetsAt` only. `fetchAlibabaToken()` already knew which windows it had marked
`backstopped` but discarded their reset times.

Risks: a pool that covers nothing must not acquire an accidental deadline; the
"resets in" wording must not be applied to a pool that never resets.

## Pre-Implementation Gate

Status: ready

Problem / root-cause model: the risk model assumed every quota either resets or
rolls. A third kind exists — a pool that replenishes never but is spent only
while another window is empty — and for it the model had no deadline, so the
burn rate had nothing to be compared against and only the fill level spoke.

Evidence reviewed: live payload showing `horizonH=None` / `level=ok` beside a
24.65h headroom; the code path above; the user's statement of the semantics.

Affected contracts and surfaces: `UsageMetric.coversUntil` (new, descriptive,
unstored), `MetricRisk.bridging` (new), the alibaba token fetcher, the MCP
`deadline()` wording, the dashboard burn line, spec and AGENTS.md.

Existing patterns to reuse: fetcher-declared descriptive fields (`backstopped`,
`rolling`, `expiresAt`); the unchanged burn-ratio rule; the `rolling` precedent
of a metric whose deadline is not its own `resetsAt`.

Risk and blast radius: confined to metrics that set the new field — only
`addon_credits` does. No storage change. No new thresholds.

Sensitive data handling plan: quota numbers and dates only; nothing identifying.

Implementation plan: field on the metric → fetcher records the soonest covered
reset → risk model uses it as the horizon → wording on both surfaces → tests →
spec/AGENTS.md.

Validation plan: unit tests for bridging (runs out / comfortably lasts / covers
nothing); a synthetic end-to-end run shaped like the live account; deploy and
compare against the live console figures.

Artifact impact plan: spec (bridge rule and the deadline sentence), AGENTS.md
(every quota is judged against a deadline; name it), no docs/skills in repo.

Open decisions: none — the user chose the coupled model explicitly.

## Implications And Decisions

1. **Deadline for a backstop pool** — chosen: the covered window's reset
   (`coversUntil`). The assistant had recommended fixed day-based thresholds
   (2d/7d, mirroring the DeepSeek balance config) and ranked the coupled model
   second; the user corrected this, and the coupled model is both more accurate
   and cheaper — it introduces no thresholds, since the ordinary burn-ratio rule
   already answers "does it last until then". Recorded because the rejected
   option looks reasonable and should not be reintroduced by accident.
2. **Wording** — a bridge deadline is never rendered as a reset: the MCP says
   `must last …, until the spent window resets`, the dashboard says `needs …`.

## Execution Log

### 2026-08-18

- `types.ts`/`common.ts`: `coversUntil`. `alibaba.ts`: collect the soonest reset
  among windows marked `backstopped` and put it on the pool. `risk.ts`: horizon
  falls back to `coversUntil`, new `bridging` flag. `mcp-server.ts` and
  `dashboard.html`: wording. Three tests added.

## Validation

Acceptance criteria evidence:

- Live after deploy (figures below), and a synthetic run shaped like the live
  account: `addon_credits (must last 2d 4h, until the spent window resets): risk
  at risk · burn 2.3%/h · headroom 22h 33m · burn ratio 2.31x`, provider `crit`,
  binding metric `addon_credits`, card line
  `Addon Credits 2.3%/h now · empty in 22h 33m · needs 2d 4h`.
- A pool covering nothing still reports `bridging: false`, `horizonHours: null`,
  `burnRatio: null` (unit test).

Tests or equivalent validation:

- `npm test` — 32 tests pass, three new: runs out before the covered reset
  (crit, ratio > 1, binding), comfortably outlasts it (ok), covers nothing (no
  deadline). `npx tsc --noEmit` clean.

Real-use evidence: deployed to the daemon host; live API and MCP output checked
against the console's own figures.

Reviewer findings: none requested.

Same-failure scan: searched for other metrics with neither `resetsAt` nor
`rolling` — OpenRouter's `credits` (window `lifetime`) is the only other one. It
is a pay-as-you-go pool that covers no window, has no deadline by nature, and its
card shows spend and pace instead; deliberately unchanged.

Sensitive data gate: no credentials, identifiers or endpoints in any artifact.

Artifact maintenance gate:

- AGENTS.md: updated — `coversUntil` in the descriptive-fields list, plus the
  rule that every quota is judged against a deadline and a new one must name it.
- Runtime project skills: none exist.
- Specs: updated — the bridge rule, and the deadline sentence in the crit rule.
- End-user/operator docs and skills: none exist in this repository.
- SOW lifecycle: completed and moved to `done/` with the implementation commit.

Specs update: `.agents/sow/specs/provider-quota-semantics.md`.

Project skills update: not needed.

End-user/operator docs update: none affected.

End-user/operator skills update: none affected.

Lessons:

- The risk model had an unstated assumption — that every quota replenishes — and
  it stayed invisible because the one metric that broke it looked healthy. A
  quota with no deadline is not low risk, it is unjudged; those two states should
  never render the same.
- The assistant's first instinct was to invent thresholds for a pool it thought
  was standalone. The user knew the pool's purpose, and purpose gave the deadline
  for free. Ask what a quota is *for* before choosing numbers for it.

Follow-up mapping: none outstanding.

## Outcome

A pool that backstops a spent window is now judged against the reset it has to
reach. The case that prompted this — credits emptying in about a day against a
gap of two — reports `at risk` with a burn ratio of 2.3x, on the card, in the MCP
and in Prometheus.

## Lessons Extracted

See Validation → Lessons.

## Followup

None.

## Regression Log

None yet.

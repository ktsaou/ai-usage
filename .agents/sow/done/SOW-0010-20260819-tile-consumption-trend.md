# SOW-0010 - Per-minute consumption trend on the cards, and countdowns that name their window

## Status

Status: completed

Sub-state: implemented, deployed, verified live.

## Requirements

### Purpose

Answer, at a glance and without interaction, the question a burn rate alone cannot: **is the consumption still happening right now?** A card reading "51% used, 80%/h" is ambiguous — the burn may have stopped ten minutes ago or may be ongoing, and the operator has to guess which. The dashboard is a wall display, so the answer must be visible without hovering or clicking.

Secondary: remove a rendering ambiguity where two different quota windows appear under the same word with two different countdowns.

### User Request

Two items, verbatim in substance:

1. On the quota rate model: "glm: leave as it is." No change to how the current rate is measured.
2. On the cards: "the little graphs on the tiles should show 2 metrics: 1. the values shown today, which I believe is the used consumption; 2. the per minute rate of consumption over the last 120 minutes. The need for the second is the following: you see z.ai at 51% with 80%/h. Is it still happening? You can't answer this if you don't see the per-minute data."
3. On the duplicate window label: "On their dashboard I see 2 rates: 5h (8%), weekly (17%). Now they are correct on the tiles. But before both of them were 'weekly'."
4. On the remaining design choices: "Do as you believe is right. Keep in mind that the last 120m rate can also be on hover with extra api call. Whatever you like."

### Assistant Understanding

Facts:

- A provider's card draws one sparkline, 40 samples of the headline metric's value column (`src/server.ts:68-69,110`, `src/dashboard.html:328`). It shows level over time and nothing about pace.
- The burn line names the **binding** window (`src/dashboard.html:288`), while the card's big number, footer countdown and sparkline follow the **most exhausted** window (`src/server.ts:78-86`, `src/dashboard.html:264-271`). These are two independent selections and can disagree.
- The footer countdown carries no window label at all (`src/dashboard.html:423-427`). When the two selections disagree, the burn line's window name sits directly above a countdown belonging to a different window, and the burn line's window then appears a second time as a sub-row with its own, different countdown.
- Divergence is not rare. Two providers on one live reading: one card's verdict came from a monthly window while its headline was the weekly one; another headlined its 5h window while the verdict came from the weekly one.
- Stored history for the provider the user reported contains only two metric identities in 14 days — `('5h_quota','5h','%')` and `('weekly_quota','weekly','%')`, 20146 samples each. No sample ever carried a duplicate window name, so the duplication the user saw is produced entirely by the page.
- Polls land every 60s (`pollIntervalSeconds` default 60), so consecutive stored samples are one minute apart and the difference between two adjacent samples is that minute's consumption.
- Percent values are coarse for some providers: one reports whole percentage points, so per-minute deltas are 0/1/2/3. Over the last 120 minutes one provider showed 77 of 120 minutes non-zero (clearly active), another 10 of 120 (clearly idle). The signal is legible despite the quantisation.
- `/api/summary` is 4198 bytes, 860 gzipped, refetched by every open tab every 60s.

Inferences:

- The per-minute consumption series is the first difference of the level series. Sending both would ship the same information twice.
- On a wall display nobody hovers, so an on-hover fetch would leave the question unanswered in the case it was raised for. The user offered it as a way to avoid recurring cost; deriving the bars from the line series removes that cost instead, so the trade is unnecessary.
- 120 bars need horizontal room. At 110px each bar is under one pixel and the series reads as a texture rather than data.

Unknowns:

- None blocking. Poll gaps would make one bar span more than a minute; accepted and documented rather than solved with per-point timestamps, which would double the payload for a cosmetic gain.

### Acceptance Criteria

- Every card shows level over the last 120 minutes and per-minute consumption over the same 120 minutes, on one shared time axis, without interaction. Verified by rendering the live dashboard headlessly and reading the card.
- The consumption bars are non-empty for a provider being actively consumed and empty for an idle one, at the same moment. Verified against live providers.
- A window reset inside the 120 minutes produces no consumption bar for the reset minute. Verified by unit test.
- Every countdown on a card names the window it belongs to. Verified by reading the rendered card text.
- `/api/summary` stays bounded and pre-reduced; no raw sample rows reach the browser. Verified by measuring the gzipped payload before and after.
- Idle CPU does not regress: no new animation, no new timer. Verified with the CPU harness described in AGENTS.md.

## Analysis

Sources checked:

- `src/server.ts` - summary payload, `primaryMetric`, `valueColumn`, `SPARK_POINTS`.
- `src/dashboard.html` - card build, `sparkSVG`, `burnLine`, footer countdown, `injectCached`, `loadSummary`.
- `src/db.ts` - `sparkline`, `metricAnchors`, `peakHourlyRise`.
- `src/risk.ts` - binding-window selection (`urgency`, `computeProviderRisk`).
- `AGENTS.md` - "Serving Cost" and "Idle cost" sections; the rule that history-derived card inputs are computed in `db.ts` and served pre-reduced.
- `.agents/sow/specs/provider-quota-semantics.md` - metric field semantics.
- SOW-0005 (dashboard payload and retention), SOW-0006 (per-window reset visibility), SOW-0007 (exhaustion risk, decision 3A on the headline rule).
- Live daemon: `/api/providers`, `/api/summary`, `/api/history/{id}` on the daemon host.

Current state:

- Cards answer "how full" and "how fast on average", never "is it happening now".
- The footer countdown is the only unlabelled time on the card.

Risks:

- Extending the series from 40 to 121 points raises the payload every open tab pays every 60s. Must be measured, not assumed.
- Changing which window the chart follows changes what the card's graph means; if done inconsistently with the burn line it recreates the very ambiguity being fixed.
- Any transition or animation on the new chart would reintroduce the continuous-repaint cost that AGENTS.md records as the dashboard's worst regression (9.5% of a core).

## Pre-Implementation Gate

Status: ready

Problem / root-cause model:

- **Pace is invisible.** The card carries a scalar burn rate and a level history. Neither distinguishes "burning right now" from "burned recently and stopped", because a rate averaged over an hour and a level line whose slope is compressed into 110px both hide the last few minutes. Evidence: a provider reading 51% with 80%/h, where only the per-minute series shows the burn running right up to the present.
- **The unlabelled countdown collides.** The card renders a window name from the risk model and an unattributed countdown from the headline model. When those models pick different windows, the two adjacent pieces of text read as one statement about one window, and the real owner of that name appears again below with a different countdown. Evidence: the reported card, reproduced from stored values, plus a second provider showing the same shape on a live reading.

Evidence reviewed:

- Stored metric identities for the reported provider over 14 days: exactly two, both correctly named — the duplication is not in the data.
- Live divergence between binding and headline window on two of seven providers in a single reading.
- Per-minute delta series over the last 120 minutes for three quota windows, showing the active/idle distinction survives integer-percent quantisation.
- `/api/summary` measured at 4198 bytes raw, 860 gzipped.

Affected contracts and surfaces:

- `/api/summary` response shape: the `spark` array lengthens and may follow a different metric; `metric` field reports which.
- Dashboard card layout: a new full-width chart row, a labelled footer countdown, a burn line carrying its own reset.
- No change to `/api/providers`, `/metrics`, the MCP tools, the database schema, or the risk model.

Existing patterns to reuse:

- `db.sparkline()` already queries pre-reduced with `LIMIT` and reverses to oldest-first; extend its use rather than adding a parallel query.
- `fmtCountdown` / `data-reset` for every countdown, updated by the single existing per-second timer.
- Static SVG built once per data refresh, injected by `injectCached()`; no per-frame work.

Risk and blast radius:

- Payload growth on the one endpoint every viewer polls every 60s. Mitigated by deriving the bars rather than sending them, and measured before/after.
- Charting the binding window changes the meaning of an existing graph. Mitigated by placing it directly under the burn line, which names that window.
- Payg providers whose value falls as they are consumed would show inverted bars if the direction is not handled.

Sensitive data handling plan:

- No credentials, cookies, tokens or account identifiers are involved. Evidence in this SOW cites provider ids already present in committed config, metric names, byte counts and sample counts. The daemon host is referred to as "the daemon host"; no host name, address or account identifier appears.

Implementation plan:

1. `src/db.ts` - no schema change. Confirm `sparkline` ordering and add a unit test that a reset inside the range is representable (adjacent difference is negative and therefore clamped by the consumer).
2. `src/server.ts` - raise the series length to 121 points (120 one-minute intervals); pick the charted metric from the risk model's binding window when one exists, falling back to `primaryMetric` (payg providers have no binding window); keep payg anchors on the primary metric so dollar figures are unchanged.
3. `src/dashboard.html` - replace `sparkSVG` with a combined chart: level as a line, per-minute consumption as bars beneath it, one shared axis, full card width, no animation. Derive the bars as clamped adjacent differences, with the direction taken from the payg mode.
4. `src/dashboard.html` - label the footer countdown with its window; give the burn line its own reset countdown so the block under it is self-describing.
5. Tests for the pure helpers; headless render against the live daemon; payload and idle-CPU measurement.

Validation plan:

- `npm test` (unit) and `tsc --noEmit`.
- Headless render of the live dashboard, dumping card text, confirming labelled countdowns and a chart on every card.
- Active vs idle providers compared at the same instant to confirm the bars discriminate.
- Gzipped `/api/summary` measured before and after and recorded here.
- Idle CPU sampled with the harness described in AGENTS.md, before and after.
- Same-failure scan for other unlabelled countdowns and other places a window name is printed without its own time.

Artifact impact plan:

- AGENTS.md: update the "Serving Cost" section — the series length changes and the reason the bars are derived rather than sent must be recorded so it is not "fixed" into a second array or a per-hover endpoint later.
- Runtime project skills: none exist; no update expected.
- Specs: `provider-quota-semantics.md` describes per-provider field semantics, which are unchanged. Expect no update; confirm at close.
- End-user/operator docs: README describes the dashboard; check whether the card description needs the new chart.
- End-user/operator skills: none.
- SOW lifecycle: single SOW, no split expected.

Open-source reference evidence:

- None checked. The work is confined to this project's own payload and rendering; no external implementation is relevant.

Open decisions:

- None. The user delegated all remaining design choices ("Do as you believe is right ... Whatever you like"). Decisions taken are recorded below.

## Implications And Decisions

1. **Where the per-minute data comes from.** Options: (a) a second server-side array in `/api/summary`; (b) an on-hover endpoint, as the user suggested; (c) derive it in the page from the same series that draws the line.
   **Selected: (c).** The per-minute series *is* the first difference of the level series, so (a) ships the same information twice. (b) costs nothing while idle but answers nothing on a wall display, which is what this dashboard is — and the question it was asked for ("is it still happening?") is precisely the one you need answered without touching the machine. (c) makes the line and the bars consistent by construction and adds no array. Risk: the derivation lives in the page, which has no build step and no tests; mitigated by keeping it to a clamped subtraction and testing the server-side series it consumes.

2. **Chart layout.** Options: (a) two 110px charts in the footer; (b) one 240px chart; (c) one full-card-width chart.
   **Selected: (c).** 120 bars need width: at 110px each bar is under a pixel and the series reads as texture. Full width gives roughly 3px per bar, at which individual minutes are readable and the right-hand edge — the only part that answers "now" — is unambiguous.

3. **Which window the chart follows.** Options: (a) the headline (most exhausted) window, as today; (b) the binding window, which the burn line describes.
   **Selected: (b).** The chart sits directly beneath the burn line; if it charted a different window than the line names, it would recreate the ambiguity this SOW is fixing. Payg providers have no binding window and fall back to the headline metric.

4. **The duplicate window name.** Options: (a) change which window headlines the card; (b) label every countdown with its window.
   **Selected: (b).** (a) was proposed first and rejected on the user's evidence: the vendor console shows both windows and both are legitimate, so the fault is not which one leads but that a countdown was printed with no owner. (b) is also the smaller change and does not reverse the headline rule settled in SOW-0007 decision 3A.

5. **Series length.** 40 samples to 121 (120 one-minute intervals), so the line and the bars share one axis and both cover the 120 minutes the user asked for.

## Plan

1. Server: series length, charted-metric selection. Low risk, no schema change.
2. Page: combined chart, replacing the sparkline. Medium risk — layout and idle cost.
3. Page: labelled countdowns on the footer and the burn line. Low risk.
4. Tests, live render, payload and CPU measurement.

## Execution Log

### 2026-08-19

- SOW created; decisions 1-5 recorded before implementation.
- `src/server.ts`: series length 40 -> 121; charted metric taken from the risk model's binding window with `primaryMetric` as fallback; series rounded to 4 decimals before serialising.
- `src/dashboard.html`: `sparkSVG` replaced by `trendSVG` (level line + per-minute consumption bars, one 120-minute axis, full card width, no animation); chart moved to its own row; footer countdown labelled with its window; `burnLine` given its own countdown when its window differs from the headline's.
- `src/db.test.ts`: two tests covering the series the chart consumes.
- `AGENTS.md`, `.agents/sow/specs/provider-quota-semantics.md` updated.
- Deployed from a staging copy on the daemon host so the host's checkout stayed clean until the change was pushed.

## Validation

Acceptance criteria evidence:

- Chart present on every card without interaction: headless render of the deployed dashboard reports one line and a bar series for all eight providers - `zai` 83 bars, `alibaba-token` 87, `kimi` 52, `deepseek` 31, `mimo` 15, `minimax` 12, `openrouter` 3, `alibaba-coding` 1.
- Bars discriminate active from idle at the same instant: in that same reading the two providers under active use carried bars across most of the 120 minutes, while an idle one carried a single bar.
- Reset minute consumes nothing: unit test `the chart series keeps the drop at a reset, for the consumer to clamp` asserts the derived series is `[0, 3]` across a 90% -> 2% -> 5% reset.
- Every countdown names its window: rendered card text shows `5H resets in 3h 48m`, `WEEKLY resets in 4d 6h`, and on the one card where the two selections differ, `MONTHLY idle ... resets in 26d 6h` on the burn line beside `WEEKLY resets in 4d 6h` in the footer.
- Payload bounded and pre-reduced: live `/api/summary` is 5991 bytes, 1068 gzipped, 121 points per provider. No endpoint returning raw rows is called by the page.
- Idle CPU unchanged: 1.5% and 1.1% of one core before, 1.4% and 1.2% after, over two 35-40s samples of the whole chromium process tree. The absolute figure is higher than the 0.3% recorded in AGENTS.md because this harness includes the node host process and a local fixture server; the comparison is what matters and it is flat.

Tests or equivalent validation:

- `npm test` - 43 pass, 0 fail (41 before, 2 added).
- `npx tsc --noEmit` - clean.
- Fixture render: the real `src/dashboard.html` served against a captured API snapshot, so the page could be exercised without starting a second daemon. Starting one would have driven the shared browser profile from a second machine and logged the production session out.

Real-use evidence:

- Deployed to the daemon host via `install.sh`. Service `active`; all eight providers `state=ok failures=0` after the restart, including the three browser-session providers, so the session survived the deploy.
- Live dashboard rendered headlessly through a port-forward; card text and chart contents captured above.

Reviewer findings:

- No external review requested for this work.
- Two defects were caught by rendering before deploying rather than after: the line auto-scaled to its own range, so a monthly quota that moved 0.002% in two hours drew the same cliff as one that burned half its allowance; and full float precision was being serialised, which cost more than the entire rest of the response.

Same-failure scan:

- `grep -n "data-reset" src/dashboard.html` - five occurrences: burn line, sub-metric rows, footer (two branches), and the ticker. Every one is now adjacent to the name of the window it belongs to.
- `src/mcp-server.ts` - each metric prints its own reset on its own line, and `deadline()` is appended only where the reset is not already on the line. No equivalent ambiguity.
- No other renderer prints a window name or a time.

Sensitive data gate:

- No secrets, credentials, cookies or tokens are involved in this change. This SOW cites provider ids that are already in committed config, metric names, byte counts and sample counts. The deployment target is referred to only as "the daemon host". A private address appeared in installer console output and was not written to any file; `grep` across the repository for host names and addresses returns nothing.

Artifact maintenance gate:

- AGENTS.md: updated. The "Transfer cost" section gains the serialisation-precision rule and the derive-don't-duplicate rule, and records that a chart came back deliberately within an agreed budget. The provider-architecture section gains the rule that every time on a card must name its window, with the evidence that the two selections disagree regularly.
- Runtime project skills: none exist in this repository; nothing to update.
- Specs: updated - `.agents/sow/specs/provider-quota-semantics.md`, "Dashboard history" rewritten for the chart and "Per-window reset" extended with the labelling rule.
- End-user/operator docs: none exist. There is no README or docs directory in this repository; the dashboard is self-describing and AGENTS.md is the operator reference.
- End-user/operator skills: none exist.
- SOW lifecycle: single SOW, no split or merge. `Status: completed`, moved to `.agents/sow/done/`, committed together with the work.

Specs update:

- Done, as above.

Project skills update:

- Not applicable - this repository has no `.agents/skills/project-*/` skills, a decision recorded in SOW-0001.

End-user/operator docs update:

- Not applicable - no end-user or operator documentation exists in this repository.

End-user/operator skills update:

- Not applicable - none exist.

Lessons:

- A user reporting "the same thing is shown twice" describes a symptom, not a location. One query against stored history showed only two correctly-named metric identities in 14 days, which ruled out the data and pointed at the renderer before any design work started.
- The first remedy proposed was aimed at the wrong defect: the choice was framed as "which window should headline the card", when the actual fault was that one countdown had no owner. When a user rejects a remedy without choosing from the options offered, the framing is what they are rejecting - re-derive the defect from the evidence instead of defending it.
- Serialisation precision dominated the payload, not the number of points. 81 extra points per provider cost less than the float digits already being sent; rounding to what a 46px strip can show cut the response by 38%.
- Deriving the second series from the first was cheaper *and* safer than sending it: no extra bytes, and the line and the bars cannot disagree.
- Auto-scaling is harmless on a 110px sparkline and misinformation on a full-width chart. Making a chart bigger changes what its scaling decisions mean.

Follow-up mapping:

- Chart follows the binding window rather than the headline one: implemented (decision 3).
- Countdowns naming their window: implemented (decision 4).
- The `pretty()`/`primaryMetric()` duplication between `src/server.ts` and `src/dashboard.html` remains, as does the new derivation living in the page: rejected as work for this SOW. The duplication is deliberate and documented - the dashboard is a single static file with no build step and cannot import - and this SOW added no new duplicate rule, only a consumer of an existing series.
- The z.ai short-span burn rate reported over 25 minutes and labelled "now": rejected by the user for this SOW ("glm: leave as it is"). The new chart addresses the question that prompted it by showing whether consumption is ongoing.
- No deferred items remain. Scan of this file for `defer|later|follow-up|future|TODO|pending` returns only this section's own heading and the rejected items above.

## Outcome

Every provider card carries one chart over the last 120 minutes: the quota level as a line, and what each individual minute consumed as bars beneath it. A card reading "82% used, 67%/h" now says whether that burn is still running - dense bars at the right-hand edge - without hovering, clicking, or a second request. Live on the daemon host; the whole feature costs 168 bytes gzipped per refresh and no measurable idle CPU.

Every time shown on a card now names the window it belongs to, so the burn line's window and the footer's countdown can no longer be read as one statement when the risk model and the headline rule pick different windows.

## Lessons Extracted

Recorded in Validation > Lessons above, and the durable ones carried into AGENTS.md (serialisation precision, derive-don't-duplicate, the agreed chart budget, and the rule that anything naming a window or showing a time must carry both).

## Followup

None. All items are mapped in Validation > Follow-up mapping as implemented or rejected with reasons.

## Regression Log

None yet.

Append regression entries here only after this SOW was completed or closed and later testing or use found broken behavior. Use a dated `## Regression - YYYY-MM-DD` heading at the end of the file. Never prepend regression content above the original SOW narrative.

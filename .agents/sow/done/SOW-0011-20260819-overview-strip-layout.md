# SOW-0011 - Overview strip wraps, and its pay-as-you-go tile reads empty for a refresh

## Status

Status: completed

Sub-state: implemented, deployed, verified live.

## Requirements

### Purpose

The overview strip is the first thing read on a dashboard that stays open on a screen. It must hold one row and state the truth at all times, whatever the provider names and figures happen to be.

### User Request

"also, the status line at the top, wraps when showing also a PAYG value. Something is wrong because the value is not big."

### Assistant Understanding

Facts:

- The strip is a `flex-wrap: wrap` row of six tiles inside `.wrap`, which is capped at 1240px with 22px page padding, so the strip is a fixed 1196px however wide the window is. Its own padding is 26px a side, leaving 1144px of content box.
- With a pay-as-you-go value present the six tiles measured 1161px, 17px more than fits, so one tile wrapped onto a second row. Without it they measured 1117px and fitted.
- The tiles' own horizontal padding was 34px a side: 408px across six tiles, more than a third of the strip.
- The user's reading is correct: the value is short. The width is consumed by the captions (`MiniMax Token Plan · 5h_quota`, `balance · 7d spend $0.97`) and the padding, not by the numbers.
- A flex item will not shrink below its longest line unless `min-width: 0` is set, so with `flex-wrap: wrap` the strip breaks into rows rather than tiles giving up width.
- Found while reproducing: the pay-as-you-go total is computed in `renderProviders()`, but the figures it sums arrive with `/api/summary`, which `tick()` fetches *after* `load()` has already rendered. The tile therefore printed its "nothing here" dash for a full refresh interval while the card beside it already showed a balance.

Inferences:

- Any fix that only trims fixed pixels postpones the problem: the content grows with provider names and values, both of which are data.

Unknowns:

- None.

### Acceptance Criteria

- The strip holds one row on a desktop viewport with a pay-as-you-go value present. Verified by measuring row count in a headless render.
- It still holds one row when a provider name and a balance are much longer than today's. Verified with a stress fixture.
- It wraps into rows rather than becoming unreadable slivers on narrow viewports. Verified across viewport widths.
- The pay-as-you-go tile shows its value on first paint, not one refresh later. Verified by reading the tile before any re-render.

## Analysis

Sources checked:

- `src/dashboard.html` - `.overview` / `.ov-item` rules, the overview markup, `renderProviders()`, `injectCached()`, `loadSummary()`, `tick()`.
- Measured in a headless render against a captured API snapshot at viewport widths 1600, 1280, 1000, 900, 700 and 420.

Current state:

- Pre-existing; not introduced by SOW-0010, which did not touch the overview strip. It becomes visible only once a pay-as-you-go provider reports a value, which is why it surfaced now.

Risks:

- Removing `flex-wrap` entirely would squeeze six tiles onto any width, including a phone.

## Pre-Implementation Gate

Status: ready

Problem / root-cause model:

- Tiles are sized to their content inside a container whose width is fixed by the page's max-width. Content is data-driven, the container is not, so the sum eventually exceeds the row and `flex-wrap` breaks it. The tiles cannot absorb the difference because a flex item's automatic minimum size keeps it at its longest line unless `min-width: 0` says otherwise. Evidence: 1161px of tiles in a 1144px content box; 17px of overflow.
- Separately, the tile's value is computed at a point in the refresh cycle where its input has not arrived yet. Evidence: `tick()` awaits `load()` (which renders) before `loadSummary()` (which fills the pay-as-you-go cache).

Evidence reviewed:

- Per-tile widths, strip width, row count and overflow measured at six viewport widths, before and after.
- `tick()` / `load()` / `loadSummary()` ordering read directly.

Affected contracts and surfaces:

- `src/dashboard.html` only: three CSS rules, one media query, and moving four lines into a function. No API, schema, server, MCP or metrics change.

Existing patterns to reuse:

- `injectCached()` is already the single place where values arriving from `/api/summary` are applied to the DOM; the total belongs with it.

Risk and blast radius:

- Layout only. The failure mode of the change is a tile narrower than intended, which reflows its caption; it cannot overflow the strip or hide a number.

Sensitive data handling plan:

- None involved. Evidence is pixel measurements and provider display names already present in committed config.

Implementation plan:

1. `.overview` to `flex-wrap: nowrap`; `.ov-item` gains `flex: 0 1 auto; min-width: 0` and drops from 34px to 26px of side padding.
2. Restore wrapping below 900px so narrow screens get rows, not slivers.
3. `.ov-num` gains `white-space: nowrap` so a figure never breaks across lines while a caption reflows.
4. Extract `updatePaygTotal()` and call it from `injectCached()`.

Validation plan:

- Headless measurement at six viewport widths, plus a stress fixture with a longer provider name and a six-figure balance.
- Read the tile's text before any forced re-render to confirm the first-paint fix.
- `npm test`, `npx tsc --noEmit`.
- Live render after deploy.

Artifact impact plan:

- AGENTS.md: add the layout invariant, since the same overflow will recur the next time a tile is added.
- Specs: the overview strip's contents are not specified in `provider-quota-semantics.md`; expect no update, confirm at close.
- Runtime project skills, end-user docs, end-user skills: none exist.
- SOW lifecycle: single SOW.

Open-source reference evidence:

- None checked; the work is a layout fix in this project's own page.

Open decisions:

- None. The user delegated remaining design choices in this area earlier in the session ("Do as you believe is right").

## Implications And Decisions

1. **How to stop the wrap.** Options: (a) trim padding until it fits; (b) shorten the captions; (c) let tiles shrink and keep one row.
   **Selected: (c)**, with a smaller padding as well. (a) and (b) buy a fixed number of pixels against content that grows with the data, so they postpone the failure rather than remove it. Under (c) the strip cannot break into two rows on a desktop viewport however long a provider name gets; the tile absorbs it and reflows its own caption.

2. **Narrow screens.** `flex-wrap: nowrap` alone would squeeze six tiles onto a phone. Wrapping is restored below 900px, where there is no width left to share. The breakpoint is 900px rather than the existing 640px because measurement showed the tiles reach their useful minimum at roughly 1000px.

3. **The empty tile.** Options: (a) leave it, since it corrects itself within a refresh; (b) compute the total where its input arrives.
   **Selected: (b).** A dash in that tile means "no pay-as-you-go providers", so for one refresh interval the strip stated something false about money while the card below it showed a balance. It also made the strip change shape a minute after load, which is how the wrap was noticed.

## Plan

1. CSS: shrink-to-fit tiles, reduced padding, non-breaking numbers, wrap restored below 900px.
2. Move the pay-as-you-go total to where its input lands.
3. Measure across widths, stress-test, deploy, verify.

## Execution Log

### 2026-08-19

- Reproduced the wrap in a headless render and measured it: 1161px of tiles in a 1144px content box.
- Applied both fixes in `src/dashboard.html`; no other file changed.
- Measured at 1600, 1280, 1000, 900, 700 and 420, plus a stress fixture.
- Deployed and verified live.

## Validation

Acceptance criteria evidence:

- One row with a pay-as-you-go value present: at 1600 and 1280 the strip is 1196px, tiles total 1073px, `rows 1`. Before the change the same fixture gave `rows 2`.
- Holds one row under stress: with a provider name extended to `MiniMax Token Plan Enterprise Annual` and a balance of `$128456.78`, tiles total 1142px against a 1144px content box, `rows 1`, no overflow. Tiles shrank to a narrowest of 125px and reflowed their captions inside themselves.
- Degrades on narrow viewports: 1000px gives one row with tiles shrunk to fit (902px of tiles in 904px); 900px, 700px and 420px wrap into 2, 2 and 5 rows respectively. No viewport overflows (`scrollWidth <= clientWidth` at every width).
- Tile correct on first paint: the pay-as-you-go tile reads `$85.32` before any forced re-render. It read `–` at that point before the change, while the DeepSeek card already showed `$85.32`.

Tests or equivalent validation:

- `npm test` - 43 pass, 0 fail.
- `npx tsc --noEmit` - clean.
- Headless measurement harness rendering the real `src/dashboard.html` against a captured API snapshot. A second daemon was not started: it would drive the shared browser profile from a second machine and end the production session.

Real-use evidence:

- Deployed to the daemon host; service `active`, all eight providers `state=ok`. Live render confirms one row with the pay-as-you-go tile populated.

Reviewer findings:

- No external review requested.
- The empty-tile defect was found while reproducing the reported one, not reported. It is fixed here rather than tracked, because the tile stated something false about money and the fix is four lines moved.

Same-failure scan:

- Other flex rows in the page: `.card-top`, `.card-foot`, `.pname`, `.hstatus`, `.sec-title`, `footer`. Only `footer` also wraps, and it is a two-item row of short strings with no fixed-width container to overflow. `.card-top` and `.card-foot` are inside a grid cell that resizes with the viewport, so their content is not competing for a fixed width.
- Other values computed during render from data fetched after it: `updatePaygTotal` was the only one. `nextReset` and the risk counters come from `/api/providers`, which `load()` fetches before it renders; sparkline and chart content already go through `injectCached()`.

Sensitive data gate:

- No secrets, credentials or identifying infrastructure in the change or in this SOW. Provider display names cited are already in committed config.

Artifact maintenance gate:

- AGENTS.md: updated - the overview strip's layout invariant added to the serving/rendering guidance.
- Runtime project skills: none exist.
- Specs: no update needed. `provider-quota-semantics.md` documents provider field semantics and the dashboard's data contract; the overview strip's tile layout is not part of either, and this change altered no data, endpoint or field.
- End-user/operator docs: none exist in this repository.
- End-user/operator skills: none exist.
- SOW lifecycle: `Status: completed`, moved to `.agents/sow/done/`, committed with the work.

Specs update:

- Not needed, for the reason recorded above.

Project skills update:

- Not applicable - this repository has no `.agents/skills/project-*/` skills (SOW-0001).

End-user/operator docs update:

- Not applicable - none exist.

End-user/operator skills update:

- Not applicable - none exist.

Lessons:

- A row of content-sized tiles inside a fixed-width container is a latent overflow: it fits until the data gets longer. The durable fix is to let the items give up width, which needs `min-width: 0` because a flex item's automatic minimum otherwise pins it to its longest line.
- The user's instinct that "the value is not big" was the useful clue. Measuring showed the numbers were never the problem - the captions and 408px of tile padding were - so trimming the number's formatting would have fixed nothing.
- Deriving a displayed total during render, from data fetched after render, prints a confident wrong value until the next cycle. Totals belong wherever their inputs are applied.

Follow-up mapping:

- Wrap: implemented.
- Empty tile on first paint: implemented.
- No deferred items. Scan of this file for `defer|later|follow-up|future|TODO|pending` returns only this section's heading.

## Outcome

The overview strip holds one row on a desktop viewport whatever the provider names and figures are: tiles now give up width and reflow their own captions instead of pushing one another onto a second row, and they wrap into rows again below 900px where there is no width left to share. The pay-as-you-go tile shows its value on first paint rather than printing a dash - which reads as "no pay-as-you-go providers" - for a full refresh interval.

## Lessons Extracted

Recorded in Validation > Lessons; the durable one is carried into AGENTS.md.

## Followup

None.

## Regression Log

None yet.

Append regression entries here only after this SOW was completed or closed and later testing or use found broken behavior. Use a dated `## Regression - YYYY-MM-DD` heading at the end of the file. Never prepend regression content above the original SOW narrative.

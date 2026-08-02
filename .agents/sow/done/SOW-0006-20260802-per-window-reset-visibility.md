# SOW-0006 - Per-window reset countdowns and headline eligibility

## Status

Status: completed

Sub-state: every window shows its own live countdown, verified against the API's
reset times on the daemon host; z.ai now headlines its 5h model quota.

## Requirements

### Purpose

Make the dashboard usable for planning. A provider caps usage over several
windows at once (5h, weekly, monthly); the operator needs to know when each one
frees up, not only the one the card happens to headline.

### User Request

"Explain how the web tiles prefer the main limit to show? I mean many providers
have 5h and weekly limits. Some may also have monthly. But only one of them is
shown with reset in duration. All the others just mentioned. It is a problem
that the dashboard does not mention all the 'reset in'. You can't plan."

Then, on the proposed options: "I like your picks" (1A + 2B), and "The mcp of
z.ai is secondary - it should never be primary."

### Assistant Understanding

Facts:

- The card headline is the metric with the highest percent used
  (`src/dashboard.html:260`), and the reset countdown is rendered only for that
  metric (`src/dashboard.html:326`).
- Sub-metric rows carry a label, a mini bar and a percentage, and no reset
  information at all (`src/dashboard.html:325`).
- Every metric already carries `resetsAt`; the page reads it across all metrics
  to compute the global "next quota reset" tile (`src/dashboard.html:308`). The
  values are present in the browser and simply never rendered per row.
- Live evidence of the consequence: Alibaba Coding headlines the monthly window
  (17% used, resets in 12 days) while the 5h window that actually blocks work
  within the hour shows no time; Kimi headlines weekly (13%, 2 days) and hides
  the 5h reset.
- z.ai's `monthly_mcp` measures hosted tool calls, not model usage, and is
  documented as such (`.agents/sow/specs/provider-quota-semantics.md:29-31`).
  At 2.775% it currently outranks the real 5h model quota at 2.0% and takes the
  headline.

Inferences:

- Comparing percentages across quotas that measure different things is not
  meaningful, so eligibility for the headline is a property of the metric and
  belongs with the fetcher that knows what the metric means — not a name check
  in the renderer.

Unknowns:

- None.

### Acceptance Criteria

- Every window on a card shows its own live reset countdown, verified in a
  browser against the reset times the API reports.
- z.ai's card headlines the 5h model quota, and `monthly_mcp` renders as a
  sub-row, verified against live data.
- No card loses its headline, including providers whose only metrics are
  lifetime balances.

## Analysis

Sources checked:

- `src/dashboard.html` (card rendering, primary selection, countdown ticker).
- `src/server.ts` (`primaryMetric`, `buildSummaryPayload`), `src/types.ts`,
  `src/providers/common.ts`, `src/providers/fetch.ts`.
- `src/mcp-server.ts`: renders every metric in a flat list and has no notion of
  a primary metric, so it is unaffected.
- Live `/api/providers` output for all eight providers.

Current state:

- Sub-rows are the only place multi-window providers are represented, and they
  are the one place with no timing information.
- `primaryMetric` exists twice — `src/server.ts` for `/api/summary`, and
  `src/dashboard.html` for the card — because the dashboard is a single static
  file with no build step. Both must apply the same rule.

Risks:

- The two copies of the selection rule can drift. Mitigated by keeping the rule
  small, commenting both, and verifying the sparkline series (server-picked)
  matches the headline (client-picked) after the change.
- Sub-rows are narrow; another field could crowd them at the smallest card
  width.

## Pre-Implementation Gate

Status: ready

Problem / root-cause model:

- The card was designed around a single "binding constraint" number, so the
  reset time was attached to the headline rather than to the metric. Once
  providers reported several windows, the information needed for planning
  landed in the rows that render the least. Evidence: `src/dashboard.html:325`
  versus `:326`.
- Separately, the selection rule assumes all percentages are comparable. z.ai
  reports a tool-call quota alongside a model-usage quota, and the rule cannot
  tell them apart. Evidence: live percentages 2.775 vs 2.0.

Evidence reviewed:

- The files and line references above; live `/api/providers` for all providers,
  including the exact percentages that decide the z.ai headline.
- `.agents/sow/specs/provider-quota-semantics.md` for what each metric means and
  for the documented headline rule that this SOW changes.
- SOW-0005 for the summary endpoint the server-side selection feeds.

Affected contracts and surfaces:

- `UsageMetric` gains an optional `secondary` flag; it rides on
  `/api/providers` and the MCP payload like `note` and `breakdown`, and like
  them is not stored in SQLite or exported to Prometheus.
- Card rendering: sub-rows gain a countdown column.
- `primaryMetric` in both `src/server.ts` and `src/dashboard.html`.
- Spec: the headline rule and the dashboard-history section.

Existing patterns to reuse:

- `metric()`'s `extra` parameter already carries descriptive, non-stored fields
  (`note`, `breakdown`); `secondary` joins them rather than inventing a channel.
- The countdown ticker updates any element tagged `data-reset`
  (`src/dashboard.html:366`), so new countdowns animate with no new timer.

Risk and blast radius:

- Presentation plus one metric-selection rule. No fetcher logic, no storage, no
  browser-session code, no scheduler changes.
- A provider whose metrics are all flagged secondary would lose its headline;
  prevented by falling back to the full candidate list.
- Prometheus and MCP consumers see one new optional field and are otherwise
  untouched.

Sensitive data handling plan:

- Usage percentages and reset timestamps only. No credentials, hosts or
  account identifiers appear in this SOW or the artefacts it touches.

Implementation plan:

1. `types.ts` + `common.ts`: optional `secondary` on a metric.
2. `fetch.ts`: flag z.ai's `monthly_mcp`.
3. `server.ts` + `dashboard.html`: prefer non-secondary metrics when choosing
   the headline, with a fallback so a headline always exists.
4. `dashboard.html`: render a live countdown on every sub-row.
5. Spec and `AGENTS.md`; validate in a browser; deploy.

Validation plan:

- Load the page against live data and read back, per card, the headline metric
  and every sub-row's countdown; compare each to the `resetsAt` the API
  reports.
- Confirm z.ai headlines `5h_quota` and shows `monthly_mcp` as a sub-row.
- Confirm the server's chosen metric (via `/api/summary`) matches the card
  headline for every provider, proving the two copies of the rule agree.
- Confirm countdowns tick without a page reload.
- `npx tsc --noEmit`.

Artifact impact plan:

- Specs: headline rule and card contents.
- `AGENTS.md`: a line on what `secondary` means and where headline eligibility
  is decided.
- Runtime project skills: none exist; nothing reusable beyond the above.
- End-user/operator docs: `CREDS.md` is credentials-only, unaffected.
- SOW lifecycle: completes in one commit with the code.

Open-source reference evidence:

- None; this is local UI behaviour.

Open decisions:

- None. Both were answered by the user.

## Implications And Decisions

1. **Per-window countdowns (user decision 1A).** Every window row shows its own
   live "resets in". Rejected: reordering rows by urgency (1B), which the user
   can still ask for once every reset is visible; row order stays stable so the
   eye learns where each window sits.
2. **Headline eligibility (user decision 2B), reinforced by the user: "the mcp
   of z.ai is secondary - it should never be primary".** The headline is still
   the most exhausted window, but a metric that measures something other than
   the plan's usage is excluded from the contest. Rejected: soonest-reset wins
   (2C), which would make the big number flip to whichever window is nearest
   rolling over — with per-row countdowns, the headline no longer has to carry
   urgency.
3. **Assistant decision — the flag lives on the metric, set by the fetcher.**
   The renderer must not special-case a metric name: only the provider module
   knows that `monthly_mcp` counts tool calls. This also keeps the server and
   the dashboard applying one rule to data rather than two lists of names.
4. **Assistant decision — a row with no reset time renders blank rather than
   "none".** Lifetime balances (DeepSeek, OpenRouter) have no window, and
   Alibaba's 5h reset is currently null from the API; a blank column keeps the
   rows readable, and the headline still says "no reset window" explicitly.

## Plan

1. Metric flag and z.ai wiring.
2. Selection rule in both renderers.
3. Sub-row countdowns and styling.
4. Docs, validation, deploy.

## Execution Log

### 2026-08-02

- Investigated the selection rule and evidenced its effects on live data.
- User approved 1A + 2B and confirmed z.ai's MCP metric must never headline.

## Validation

Acceptance criteria evidence — read out of the rendered page on the daemon host
at 00:47 UTC and compared row by row with the reset times `/api/providers`
reports:

| card | headline (countdown) | window rows (countdown) | API reset times |
|---|---|---|---|
| Alibaba Coding Pro | monthly, 12d 15h | 5h → `now`; weekly → 15h 12m | 5h 00:47, weekly 16:00, monthly 08-14 16:00 |
| Kimi Coding | weekly, 2d 12h | 5h → 1h 11m | 5h 01:59, weekly 08-04 12:59 |
| Z.AI Max | **5h**, 1h 34m | monthly mcp → 1d 12h | 5h 02:21, monthly_mcp 08-03 13:28 |
| Alibaba Token Pro | weekly, 10h 51m | 5h → blank | 5h **none**, weekly 11:39 |
| DeepSeek Balance | no reset window | topped up → blank | both none |

Every countdown matches its metric's reset time to the minute. The user's case
is fixed: Alibaba Coding previously showed one countdown (12 days to the monthly
reset) and now shows all three windows, including the 5h one that gates work.

- **Headline eligibility.** `/api/providers` reports `monthly_mcp` with
  `secondary: true` and percent 2.775 against `5h_quota` at 2.0; the card
  headlines `5h_quota` and renders Monthly MCP as a row. `/api/summary` returns
  `zai → 5h_quota`, so the server and the page agree.
- **No card left headless.** DeepSeek and OpenRouter, whose metrics have no
  percentages at all, still headline correctly through the fallback.
- **Countdowns are live.** Overwriting every sub-row countdown in the DOM with a
  placeholder; 1.6s later the page's one-second ticker had restored all of them
  to the correct values, confirming they update without a re-render.

Tests or equivalent validation:

- `npx tsc --noEmit` clean.
- Cross-check of all eight cards against the API, as tabulated above.
- Layout check at a 380px viewport (the narrowest the card grid allows before it
  reflows): row content measured 294px in a 294px row, no overflow, mini bar
  still 82px wide.

Real-use evidence:

- Deployed to the daemon host and verified there with all eight live providers,
  including the only three-window provider, which cannot be exercised locally
  (its session cookies are shared and must not be polled from two machines).
- No errors in the service journal after the restart.

Reviewer findings:

- Self-review: the first instinct was to have the renderer skip `monthly_mcp` by
  name. Rejected — the renderer cannot know what a metric measures, and the rule
  would have to be repeated in the server copy of the selection. The flag is set
  where the knowledge is, in the z.ai fetcher.
- Self-review: an early version had no fallback, which would have left a card
  with no headline if a provider's metrics were all flagged. Added and tested
  via the two providers whose metrics carry no percentages.

Same-failure scan:

- `src/mcp-server.ts` lists every metric with its own reset time already
  (`src/mcp-server.ts:73-96`), so the MCP never had this gap.
- The global "next quota reset" tile already scanned all metrics
  (`src/dashboard.html:308`); the card was the only surface that dropped
  per-window timing.
- No other provider reports a metric measuring something other than plan usage,
  so `secondary` applies to one metric today.

Sensitive data gate:

- Percentages, reset timestamps and metric names only. No credentials, cookies,
  host names, addresses or account identifiers in this SOW, the spec, the code
  comments or `AGENTS.md`. Validation screenshots stayed in the gitignored
  `.playwright-mcp/` directory and were not committed.

Artifact maintenance gate:

- `AGENTS.md`: updated — what `secondary` means, where headline selection lives,
  and the rule that renderers must not infer it from a name.
- Runtime project skills: none exist; the durable rules belong in `AGENTS.md`
  and the spec, and are recorded there.
- Specs: `provider-quota-semantics.md` updated — headline eligibility,
  per-window reset rendering, `secondary` in the self-description list, and the
  z.ai entry.
- End-user/operator docs: `CREDS.md` is credentials-only and unaffected; no
  README exists.
- End-user/operator skills: none exist.
- SOW lifecycle: completed and moved to `done/` in the same commit as the code.

Specs update:

- Done.

Project skills update:

- None; reason above.

End-user/operator docs update:

- None affected; reason above.

End-user/operator skills update:

- None exist.

Lessons:

- See Lessons Extracted.

Follow-up mapping:

- None deferred. Option 1B (ordering window rows by urgency) was presented and
  not chosen; it is a preference the user can ask for now that every reset is
  visible, not an unfinished part of this work.

## Outcome

Cards now show a live countdown for every window a provider caps, not only the
one that happens to be most used. The concrete case that prompted this: Alibaba
Coding displayed a single "12 days" countdown for its monthly window while its
5h window — the one that actually stops work — showed nothing; it now shows all
three.

Separately, a metric can declare itself ineligible for the headline. z.ai's
`monthly_mcp` counts hosted tool calls and was winning the card by 0.775
percentage points over the real 5h model quota; the card now headlines the 5h
quota, and the tool-call quota remains visible as a row.

## Lessons Extracted

- The information a user needs to *plan* is not the same as the information that
  describes *state*. The card was built to answer "how used is this?" and
  answered it well, while the question actually being asked was "when can I use
  it again?" — and that answer existed in the payload the whole time, unrendered.
- Ranking by a single number requires the numbers to mean the same thing.
  Percent-used looked universal, so quotas measuring unrelated things were
  silently compared. The fix is not a better comparison but excluding what is
  not comparable, decided where the meaning is known.
- A rule duplicated for a good reason (no build step in the dashboard) needs the
  duplication written down at both sites and in the spec, or the next change
  will fix one copy.

## Followup

None.

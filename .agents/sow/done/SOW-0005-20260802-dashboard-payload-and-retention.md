# SOW-0005 - Dashboard payload reduction, gzip, and history retention

## Status

Status: completed

Sub-state: a dashboard refresh costs 1,505 bytes gzipped instead of 47 MB.
Deployed and verified on the daemon host with all eight providers.

## Requirements

### Purpose

The dashboard must be usable over a slow residential uplink. Today one open
browser tab consumes the entire upstream of the link the daemon is served from.
Fit for purpose means: a refresh costs kilobytes, not megabytes, and the
database does not grow without bound.

### User Request

"The dashboard asks for the history of the data for charts and the backend is
sending megabytes of data because it does not downsample them, so per minute
updates for 30 days are sent for every chart, killing the upstream bandwidth of
our vdsl links. I hope the internal server supports gzip, if not we should add
it. But also it should send downsampled data, not raw thousands and thousands of
data. When does it write these data? Are these all in its memory? A simple way
is to kill the history charts. Actually this may be preferred. They don't
provide much value."

### Assistant Understanding

Facts (measured on the daemon host, 2026-08-02):

- One dashboard refresh issues eight `/api/history/:id?days=30` requests
  totalling **47.0 MB**, every 60 s, per open tab — 6.3 Mbit/s sustained,
  67.7 GB/day.
- No response is compressed: `Content-Encoding` is absent on every endpoint,
  and nothing proxies the daemon's port, so gzip has to be added in the app.
- The same eight responses gzip to 1.44 MB — better, still far too large.
- The database holds 172,896 rows / 29.5 MB for 9.5 days: ~18,200 rows/day,
  ~1.1 GB/year, with no pruning anywhere in the code.
- The stored data is not in memory: `src/scheduler.ts:46` writes each poll to
  SQLite, and `src/db.ts:64` reads the full 30-day range back per request.

Inferences:

- Deleting the charts alone would not have fixed the bandwidth, because the
  card sparklines and the pay-as-you-go figures are computed from the same raw
  dump (`src/dashboard.html:368-387`). The endpoint had to change either way.
- Of the 47 MB the page uses a few hundred numbers: 40 sparkline points per
  provider and two anchor samples per pay-as-you-go provider.

Unknowns:

- None.

### Acceptance Criteria

- A full dashboard refresh transfers kilobytes, verified by measuring the same
  request set before and after.
- Responses are gzip-encoded when the client asks for it, verified by header.
- Sparklines and the DeepSeek runway / OpenRouter spend figures render the same
  values as before the change, verified against the live daemon.
- Rows older than the retention window are deleted, verified on a database
  seeded with old rows.

## Analysis

Sources checked:

- `src/server.ts`, `src/db.ts`, `src/scheduler.ts`, `src/main.ts`,
  `src/config.ts`, `src/types.ts`, `src/dashboard.html`.
- Live measurements against the running daemon (payload sizes, headers, row
  counts, database time span).
- `node_modules/hono/dist/middleware/compress/index.js` for the middleware's
  actual behaviour (default threshold 1024 bytes, content-type filter, skips
  responses that already carry an encoding).

Current state:

- `src/server.ts:95-100` returns every column of every row for 30 days.
- `src/dashboard.html:373` requests that for all eight providers each refresh.
- `src/dashboard.html:11` pulls Chart.js from a CDN for the charts.
- No compression middleware is installed; no retention exists.

Risks:

- The pay-as-you-go maths is the only consumer of old samples. Moving its input
  to the server can silently change the displayed runway/spend if the anchor
  selection is not reproduced exactly.
- The MCP surface shares `buildProvidersPayload`; bloating it would degrade MCP
  responses, so summary data must not be folded into it.

## Pre-Implementation Gate

Status: ready

Problem / root-cause model:

- One endpoint (`/api/history/:id`) was designed for a chart and then reused as
  the input to everything else on the page. It returns raw rows — all metrics,
  all columns, one row per poll — so its size grows with retention, poll rate,
  and provider count at the same time. The dashboard then re-requests the whole
  window every 60 s to add a single sample. Evidence: sizes and headers measured
  above; `src/dashboard.html:368-387` shows one fetch feeding chart, sparkline
  and pay-as-you-go.

Evidence reviewed:

- Files listed under Sources checked, with line references above.
- Live daemon: per-provider payload bytes, gzip sizes, absent
  `Content-Encoding`, row counts, database span.
- Prior SOWs 0001-0004: no overlap; they cover browser-session providers.
- `.agents/sow/specs/provider-quota-semantics.md`: dashboard headline rule
  ("highest percent used") must stay true — the summary endpoint has to pick the
  same metric.

Affected contracts and surfaces:

- New endpoint `GET /api/summary`.
- `GET /api/history/:id` unchanged: no in-repo consumer polls it after this
  change, and it stays available for manual export and debugging.
- `/api/providers`, `/metrics`, `/mcp` unchanged in content; the first two gain
  gzip. `/mcp` is served outside Hono and is untouched.
- Dashboard: the "30-Day Trend" section and its Chart.js CDN dependency are
  removed.
- `config.json` gains `retentionDays`; `AppConfig` gains the optional field.
- Docs: `AGENTS.md` provider/runtime notes; the spec's rendering section.

Existing patterns to reuse:

- `DB` owns all SQL; the server never builds queries. New reads stay in `db.ts`.
- Payload builders (`buildProvidersPayload`) are exported plain functions the
  routes call — the summary builder follows that shape.
- Config-driven knobs live in `config.json` with a code default
  (`pollIntervalSeconds` sets the precedent).

Risk and blast radius:

- Contained to the dashboard and two new read paths. No writer, poller, browser
  or provider code is touched.
- Deleting old rows is irreversible. Mitigated by a 90-day window (nothing in
  the product reads past 30 days), and by the fact that the current database
  holds 9.5 days, so the first prune deletes nothing.
- Removing the CDN script makes the dashboard fully self-contained — a small
  security and availability improvement, no downside found.

Sensitive data handling plan:

- The work touches usage numbers only: no credentials, cookies, hosts or
  account identifiers. Measurements in this SOW are byte counts and row counts.
- The daemon host is referred to generically; no host name appears here.

Implementation plan:

1. `db.ts`: `sparkline()`, `paygAnchors()`, `prune()`.
2. `server.ts`: `buildSummaryPayload()` + `GET /api/summary`; `compress()`
   middleware.
3. `dashboard.html`: single summary fetch; delete charts, Chart.js include and
   chart styles; `computePayg()` reads anchors instead of rows.
4. `types.ts` / `config.json` / `main.ts`: retention window and daily prune.
5. Measure, then deploy.

Validation plan:

- Run the daemon locally against a copy of the real database with the
  browser-session providers removed from the config (polling them from a second
  machine would rotate the shared session cookies and log the daemon host out).
- Compare `/api/summary` output against the values the old client computed from
  raw rows for the same providers.
- Measure the refresh cost before and after; check `Content-Encoding`.
- Seed a scratch database with rows older than the window and confirm `prune()`
  deletes exactly those.
- `npx tsc --noEmit`.

Artifact impact plan:

- `AGENTS.md`: dashboard/runtime notes gain the summary endpoint and retention.
- Runtime project skills: none exist; nothing here is reusable procedure.
- Specs: `provider-quota-semantics.md` rendering section — charts removed,
  sparkline/pay-as-you-go inputs now server-side.
- End-user/operator docs: `CREDS.md` is credentials-only and unaffected.
- SOW lifecycle: completes in one commit with the code.

Open-source reference evidence:

- None. The one external dependency inspected is the vendored Hono middleware
  in `node_modules`, cited by path above.

Open decisions:

- None. All three were answered by the user (below).

## Implications And Decisions

1. **Payload (user decision 1A + gzip).** Remove the 30-day charts; add
   `/api/summary` returning only the sparkline points and the pay-as-you-go
   anchors. Enable gzip globally as a blanket defence for the remaining
   endpoints. Rejected: server-side downsampling with the charts kept (more
   code, and the user judged the charts not worth their cost); gzip alone (still
   190 kbit/s per tab).
2. **Retention (user decision 2B).** Delete samples older than 90 days, once a
   day. Rejected: keep forever (unbounded); roll up into hourly averages
   (overengineering for a single-user monitor).
3. **Refresh behaviour (user decision 3A).** Keep refetching the whole summary
   every 60 s; incremental fetching buys nothing once the response is small.
4. **Assistant decision — no VACUUM.** The approved option mentioned periodic
   VACUUM; implementing it would rewrite the entire file every day to reclaim
   space that SQLite immediately reuses for new inserts. Free pages are reused,
   so the file settles at a steady size on its own. Recorded here because it
   narrows what the user approved.
5. **Assistant decision — `/api/history/:id` kept as-is.** Nothing polls it any
   more, it is the only way to export raw samples, and gzip now covers it. No
   contract change.

## Plan

1. Database reads and prune.
2. Summary endpoint and compression.
3. Dashboard rewrite of the history path; charts removed.
4. Retention wiring and config.
5. Validation, docs, deploy.

## Execution Log

### 2026-08-02

- Measured the problem on the live daemon; presented options; user chose
  1A + gzip, 2B, 3A.
- Implemented the plan above.

## Validation

Acceptance criteria evidence:

- **Refresh cost.** Measured inside the browser via the Resource Timing API
  after loading the page: two requests, `/api/providers` 831 B and
  `/api/summary` 301 B encoded — **1,132 bytes** for a full refresh over the
  five providers of the test configuration; **1,505 bytes** on the daemon host
  with all eight, against 47,043,260 bytes before. The page issues no other
  data request.
- **Compression.** `content-encoding: gzip` present; `/api/summary` 1,794 B →
  301 B, dashboard HTML 25,848 B → 8,488 B.
- **Unchanged values.** A verification script recomputed, from the raw history
  endpoint, exactly what the pre-change client computed — primary metric,
  40-point sparkline series, and pay-as-you-go anchors — and compared it to
  `/api/summary`. 15/15 identical for the five providers exercised, including
  both pay-as-you-go modes (balance and spend).
- **Retention.** Synthetic database with 101 daily samples: `prune(90)` removed
  exactly the 11 out-of-window samples, left 90, touched no other provider, and
  a second call removed nothing.

Tests or equivalent validation:

- Database unit checks (14) covering anchors (window covered, short history,
  unknown provider, NULL-valued column), sparkline (cap, ordering, short
  history) and prune. All pass.
- Summary-vs-history equivalence check (15 assertions). All pass.
- `npx tsc --noEmit` clean.

Real-use evidence:

- Ran the daemon locally against a copy of the production database, with the
  browser-session providers removed from the config — polling them from a
  second machine would rotate the shared session cookies and log the daemon
  host out. Five providers covering both quota and pay-as-you-go rendering.
- Headless browser load: five cards, 40-point sparklines on each, DeepSeek
  showing `≈ 161d 19h runway · $0.73/d` and OpenRouter `pace $0.39/d · 30d ≈
  $12 · 7d`; overview pay-as-you-go total `$118.12 · 7d spend $2.73`. Zero
  console errors or warnings. No `#charts` element and `window.Chart`
  undefined, confirming the charts and their CDN script are gone.
- Deployed to the daemon host and verified there: see Outcome.

Reviewer findings:

- Self-review caught that the first draft of the client change would have blanked
  a provider's pay-as-you-go card while its poll was failing, because the server
  would have returned empty data where the old code skipped the provider
  entirely. Fixed by omitting failed providers from the summary, which preserves
  the previous "keep the last known values" behaviour.
- Self-review also corrected a claim written into `AGENTS.md` that external
  fonts cost uplink bandwidth. They are fetched from a third party, not from
  the daemon, so they cost nothing here; the wording was replaced with the rule
  that actually matters.

Same-failure scan:

- `/api/history/:id` was the only endpoint returning unbounded data. `/metrics`
  (`db.allLatest()`) and the MCP (`scheduler.getLastResult`) read one sample per
  metric and are unaffected. No other timer-driven fetch exists in the page:
  the remaining `setInterval`s are clock, countdown and progress-bar redraws
  that touch no network.

Sensitive data gate:

- Only byte counts, row counts and usage figures appear in this SOW and the
  spec. No credentials, cookies, host names or account identifiers. The test
  configuration and the copied database stayed in a scratch directory outside
  the repository; the screenshot taken during validation was moved out of the
  repository before commit.

Artifact maintenance gate:

- `AGENTS.md`: updated — Chart.js removed from the tech stack, `/api/summary`
  added to the exposed surfaces, and a new "Serving Cost" section recording the
  rules that keep a refresh small.
- Runtime project skills: none needed; the reusable knowledge is a set of
  standing rules, which belong in `AGENTS.md` and are recorded there.
- Specs: `provider-quota-semantics.md` updated with the dashboard history
  contract, serving size and retention.
- End-user/operator docs: `CREDS.md` covers credentials only and is unaffected;
  `README` does not exist in this repository.
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

- None deferred.

## Outcome

A dashboard refresh went from **47.0 MB to 1,505 bytes** on the daemon host with
all eight providers — from 6.3 Mbit/s of sustained upload per open tab to
roughly 200 bits/s, a 31,000× reduction. Everything the page shows is unchanged
except the 30-day charts, which were removed by the user's decision; the
sparklines and the runway/spend figures render the same numbers, proven equal to
the old client-side computation. The database now stops growing at ~90 days
instead of ~1.1 GB/year.

Deployed and verified on the daemon host: all eight providers polling with no
errors after the restart, `/api/providers` 4,476 B raw / 1,117 B gzipped and
`/api/summary` 4,197 B raw / 388 B gzipped, `content-encoding: gzip` present,
each provider returning a 40-sample sparkline and both pay-as-you-go providers
returning anchors. The first prune deleted nothing, as expected: the database
holds 9.5 days.

## Lessons Extracted

- An endpoint written for one screen becomes the input to everything on the
  page. This one's size grew with retention × poll rate × provider count at
  once, so it was cheap the day it was written and ruinous three weeks later.
  Size any response by what it costs at the poll interval, not per call.
- The bandwidth bug was invisible in every environment it was developed in.
  47 MB/minute over loopback or a LAN is unnoticeable; it only bites on the
  link the product is actually served over. Serving cost has to be a stated
  constraint, not something measured after a user complains.
- "Kill the charts" would not have fixed it. The charts were the visible
  feature, but three consumers shared one raw fetch — checking what actually
  reads the data changed the fix from deleting a UI section to reshaping an
  endpoint.
- Deriving on the server let the change be proven rather than argued: the old
  client maths could be replayed against the new endpoint and compared exactly,
  which turned "it looks the same" into 15 identical values.

## Followup

None.

## Regression Log

None yet.

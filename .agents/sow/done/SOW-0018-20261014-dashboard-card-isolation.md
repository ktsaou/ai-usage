# SOW-0018 - Dashboard: one malformed card must never take the page down

## Status

Status: completed

Sub-state: Delivered 2026-10-14; deployed and verified live.

## Requirements

### Purpose

The dashboard is meant to stay open on a screen indefinitely. A single provider
whose payload is degenerate (a poll that succeeded but carried no quota windows)
must degrade that one card, never the whole page.

### User Request

"alibaba coding should be disabled, I unsubscribed, but why it broke the entire
page" and "the problem is that it crashed the dashboard. The dashboard should
never crash because one of the providers has an error. no?"

Decisions recorded by the user:

- The alibaba-coding plan was unsubscribed by the user; park it (done in the
  same change set, `config.json` `parked: true`).
- A provider that polls OK but reports zero metrics renders a **down-style
  card** ("poll succeeded but the vendor reported no quota windows") and is
  **counted as crit** in the overview counters.

### Assistant Understanding

Facts:

- `renderProviders()` (src/dashboard.html) maps every provider into one HTML
  string with no per-card isolation; any throw kills the whole render, and
  `load()`'s catch then mislabels the page "daemon unreachable".
- The crash path: `state:'ok'` with `metrics: []` reaches the normal card path;
  `headlineMetric()` → `primaryMetric([])` returns `null`
  (src/dashboard.html:297); line ~489 then reads `prim.window` unguarded →
  TypeError.
- Existing degraded paths already handle parked providers, missing first poll,
  `state:'down'`, and `state:'stale'`. The zero-metrics OK state is the one
  uncovered case.
- Real trigger: the alibaba-coding plan was unsubscribed; the vendor's quota
  block stopped carrying window fields (journal
  `[alibaba-coding] quota block has no window fields` every poll since the
  Oct 10 re-login; two transient hits Sep 28/29).
- `injectCached()` and `loadSummary()` are already guarded (the provider is
  absent from `/api/summary`; `if(sp)` guards the trend injection).
- `alibaba-token` stores 1 metric (monthly_quota only): the addon pool stopped
  being emitted. Journal shows no shape warning for the token usage endpoint,
  so this reads as the reserve actually emptying (66,472/100,000 on Oct 10) or
  the addon summary call failing; either way the card is correct under the
  SOW-0017 semantics (spent monthly window, reset 2026-10-19 16:00 UTC). No
  code change; monitored.

Inferences:

- Any future vendor reshape that empties a provider's metrics list would have
  reproduced this crash; the isolation fixes the class, not just the instance.

Unknowns:

- None blocking. The exact reason the token addon pool is no longer emitted
  (drained vs. call failure) is observable from the next manual login or the
  addon endpoint; it does not affect this change.

### Acceptance Criteria

- A headless load of the dashboard against mocked `/api/providers` +
  `/api/summary` containing the real degenerate payload (OK + zero metrics,
  risk null) renders every card, shows the no-data card as down-style with the
  agreed message, counts it as crit, and logs no console errors.
- The same harness with one card forced to throw still renders all other cards
  (isolation proof).
- The real dashboard on the daemon renders all providers with no console
  errors after deploy.
- `npm test` stays green (no model/SQL changes expected).
- Sensitive-data gate: no hosts, tokens, cookies or account identifiers in
  this SOW, code, or commit.

## Pre-Implementation Gate

- Problem / root-cause model: vendor serves a quota block with no window
  fields for an unsubscribed plan; the fetcher honestly reports state OK with
  zero metrics; the dashboard's normal card path assumes at least one metric
  and dereferences a null headline (`prim.window`, src/dashboard.html:489);
  the per-provider map has no exception isolation, so one throw blanks every
  card and `load()` misreports it as an unreachable daemon.
- Evidence reviewed: daemon journal (error every poll since Oct 10 22:23 UTC
  restart; transient hits Sep 28/29), `/api/providers` payload for
  alibaba-coding (state ok, failures 0, metrics [], risk null, subscription
  INVALID ending 2026-10-15), src/dashboard.html:285-303, 446-534, 537-556,
  src/providers/alibaba.ts:246-253, AGENTS.md card-contract section,
  SOW-0017 (token plan semantics), SOW-0008 (vendor shape change method).
- Affected contracts and surfaces: dashboard card rendering (all providers),
  overview counters (crit counting), daemon config (parking), deployed
  service; no API, schema, MCP or metrics changes.
- Existing patterns to reuse: the down-card template
  (`lf.state==='down'` branch), the parked-card template, the
  `crit++`/counter conventions, `esc()`, `colorFor()`.
- Risk and blast radius: dashboard-only; worst case a card renders as down
  when it should show data — visible, not destructive. Parked provider stops
  polling (intended; history and fetcher retained; resume is one flag).
  No data loss; no restart-sensitive state touched (profile untouched).
- Sensitive data handling plan: none introduced; payloads quoted in this SOW
  are generic; no host names, cookies, or account identifiers.
- Implementation plan: (1) explicit zero-metrics branch in
  `renderProviders()` after the `state==='down'` branch (down-style card,
  agreed message, `crit++`, not counted live); (2) wrap the per-card build in
  try/catch returning the down-card template with "render error: <message>"
  and a console.error; (3) guard `prim.window` → `prim&&prim.window`;
  (4) park alibaba-coding in config.json (already deployed).
- Validation plan: static harness (dashboard.html + mocked extensionless
  `/api/providers` and `/api/summary` files served over HTTP) loaded in a
  headless browser: degenerate payload set and an isolation-proof set (a card
  forced to throw via a patched payload); `npm test`; deploy to the daemon;
  verify the live page headlessly over an SSH tunnel; journal check.
- Artifact impact plan: AGENTS.md card-contract paragraph gains one sentence
  (a zero-window OK poll renders as a down card; a card can never take the
  page down). Spec `provider-quota-semantics.md` unchanged (metric semantics
  untouched). No new project skill. This SOW closed with the same commit as
  the code.
- Open decisions: none remaining (card appearance and crit counting decided
  by the user; parking authorized by the user).

## Implementation

- config.json: alibaba-coding `parked: true` (deployed and verified live
  before this SOW was written; the page recovered immediately).
- src/dashboard.html: zero-metrics branch, per-card try/catch isolation,
  `prim.window` guard.
- AGENTS.md: one sentence added to the card-contract paragraph.

## Validation

- Static harness (dashboard.html + real daemon payloads, served over local
  HTTP, headless browser):
  - Degenerate case: alibaba-coding de-parked with `state:'ok'`,
    `metrics: []`, `risk: null` → card renders down with "⚠ poll succeeded
    but the vendor reported no quota windows", counted in crit, all 10 cards
    painted, **0 console errors**.
  - Isolation proof: synthetic provider whose sub-metric carries a string
    `percent` (throws `sp.toFixed is not a function` in the sub-row) → that
    card alone renders "⚠ card render error: …" with a down chip; the other 9
    cards render normally; the only console entry is the isolation logger's
    own `card render failed:` line.
  - First harness run also showed the throwing metric being promoted to the
    headline when it was the only non-null percent (renders NaN instead of
    throwing) — pre-existing headline behavior, unchanged here; noted so a
    future NaN sighting is not mistaken for this fix failing.
- `npm test`: 73 pass, 0 fail (no model/SQL changes).
- Live verification on the daemon after deploy: 9 cards, coding card `parked`,
  8 live providers with correct chips, health "attention needed" (crit —
  token monthly window spent until the 2026-10-19 reset), **0 console
  errors**.
- Same-failure search: all other consumers of provider payloads checked —
  `loadSummary()`/`injectCached()` (try/catch + `if(sp)` guards), overview
  counters and `cardRank()` (`p.risk?` guards), `tickCountdowns()` (DOM-only),
  the `nextReset` loop (safe on an empty list), server-side `primaryMetric()`
  (returns null safely; `/api/summary` omits the provider). No other
  unguarded metrics dereference found in any renderer.
- Sensitive data gate: no hosts, tokens, cookies, or account identifiers in
  the SOW, code, or payloads quoted; harness payloads were local-only
  scratch, never committed.
- Artifact maintenance gate: AGENTS.md card-contract paragraph updated
  (zero-window polls render down; per-card error frames). Spec untouched —
  metric semantics unchanged, this is rendering behavior only. No new project
  skill — the knowledge is one sentence of contract, recorded here and in
  AGENTS.md. End-user/operator docs: none affected (no README change — the
  dashboard's visual states are not documented there).

## Outcome

Delivered (2026-10-14):

- The dashboard can no longer be taken down by one provider's payload: every
  card builds in its own error frame, and a poll that succeeds with zero
  metrics renders an explicit down card.
- alibaba-coding is parked (`config.json`), per the user's unsubscription;
  fetcher and history retained, resume is one flag.
- Deployed to the daemon and verified live; page renders fully with zero
  console errors.

Lessons:

- The failure class was "renderer assumes a well-formed success payload".
  The vendor will keep reshaping responses (three times so far this project);
  renderers must assume any field list can come back empty.
- A thrown render error surfaced as "daemon unreachable" — the catch-all in
  `load()` conflated fetch failure with render failure. The per-card frames
  remove the practical path to that lie; `load()` itself is unchanged.

Follow-ups:

- alibaba-token `addon_credits` stopped being emitted after Oct 10 (1 metric
  stored). Journal shows no shape warning, so this reads as the reserve
  draining (66,472/100,000 on Oct 10) or the addon summary call failing; the
  card is correct under SOW-0017 semantics either way. Confirm at the next
  login (~2026-10-24) or via the addon endpoint; reopen under SOW-0017
  semantics if the shape changed.
- alibaba-coding subscription read INVALID ending 2026-10-15 — consistent
  with the user's unsubscription. If the plan is repurchased, unpark by
  removing `"parked": true` in config.json; the fetcher will report the
  windows it serves.

# SOW-0019 - Browser provider: retry transport failures; trim stack noise from errors

## Status

Status: completed

Sub-state: Delivered 2026-10-21; deployed; 24h journal check pending.

## Requirements

### Purpose

A single chromium transport hiccup (stale pooled socket or DNS between 60s
polls) must not surface as a failed poll, and Playwright stack frames must not
pollute tiles or API error text.

### User Request

"I frequently see this error on the tiles: ⚠ cached — last read 09:27:17 ·
page.evaluate: TypeError: Failed to fetch at eval (eval at evaluate …) why?"
After analysis, the user chose option **3**: retry on transport failure AND
sanitize the stored error text.

### Assistant Understanding

Facts:

- Browser providers execute their quota calls as `fetch()` inside the
  logged-in page via `page.evaluate` (src/providers/mimo.ts apiFetch GET;
  src/providers/alibaba.ts gatewayFetch POST). Neither has any retry.
- Journal (daemon host): ~406 `page.evaluate: TypeError: Failed to fetch` errors in
  3 days (~5% of browser polls), present since at least Sep 23 (retention
  start). mimo and alibaba-token fail at the *same second* (shared chromium
  process; connections established in the same poll cycle). No browser
  restarts in the windows; failures are single-cycle with successes between.
- During the 05:00–06:00 burst the Node-fetch providers had zero failures →
  host network is not the cause; the chromium network stack is (idle keep-alive
  socket reuse / cached DNS is the classic signature; JS cannot see the
  underlying `net::ERR_` code).
- Auth failure and tab-document staleness are detected by other, separate
  paths (200-envelope codes, `usable()` re-navigation) — unaffected here.
- The scheduler records `result.error` raw into the failures map
  (src/scheduler.ts poll(), ~line 77) — the single choke point feeding the
  tile, `/api/providers` `lastFetch.error`, and the MCP.
- `callGateway` already retries for the *logged-out* class (force re-navigate);
  transport rejections currently propagate as a failed poll.

Inferences:

- Vendor load balancers dropping idle connections under chromium's socket pool
  between polls is the most consistent explanation for the same-second,
  self-healing, browser-only pattern.

Unknowns:

- The exact `net::ERR_` code (not visible from page JS; not needed for the
  fix — all transport classes heal the same way).

### Acceptance Criteria

- A browser quota call that rejects with a transport-class error is retried
  once after a short backoff; a single transient failure no longer produces a
  failed poll (verified: unit test + journal count after deploy).
- Non-transport errors are NOT retried (unit test).
- Stored/displayed error text has Playwright stack frames trimmed; the
  journal keeps the full text (unit test + live tile check).
- `npm test` green including the new cases.
- Sensitive-data gate: nothing new written to durable artifacts.

## Pre-Implementation Gate

- Problem / root-cause model: in-page `fetch()` reuses chromium's pooled
  keep-alive socket / cached DNS across the 60s idle gap between polls; when
  the peer has gone away underneath, the fetch rejects at transport level
  ("Failed to fetch"), the evaluate propagates, the scheduler records a failed
  poll, and the tile shows stale with a stack-trace string. Evidence: journal
  counts, same-second cross-provider correlation, Node-side cleanliness during
  browser bursts, code inspection (no retry in this path).
- Evidence reviewed: daemon-host journal (3-day window + retention-oldest hits),
  src/providers/browser.ts (usable/getPage), mimo.ts (apiFetch), alibaba.ts
  (gatewayFetch/callGateway/relogin paths), scheduler.ts (failure recording),
  server.ts (lastFetch assembly), AGENTS.md transient-fault doctrine
  ("Every poll must be able to rebuild what it needs" / "Transient network
  faults are permanent bugs unless a poll can heal them").
- Affected contracts and surfaces: in-page fetch path of the two browser
  providers (mimo, alibaba-token; coding is parked and shares alibaba.ts);
  stored error text on /api/providers lastFetch.error, dashboard tiles, MCP
  provider output; no schema, metric, or endpoint changes.
- Existing patterns to reuse: shared helpers live in src/providers/common.ts;
  scheduler console lines keep full detail; the logged-out retry in
  callGateway shows the retry-on-reuse idiom; providers.test.ts style for
  unit coverage.
- Risk and blast radius: retry doubles the call ONLY on transport failure
  (read-only usage endpoints — safe to repeat even as POST); worst case a
  second consecutive failure wastes ~750ms inside the poll; no vendor
  side effects (quota reads). Sanitization risk: cutting a message that
  legitimately contains " at " — mitigated by matching stack-frame shapes
  only (` at eval`, ` at UtilityScript`, ` at <anonymous>`, ` at …:line:col`).
  Auth-detection and relogin flows untouched (classifier is transport-only).
- Sensitive data handling plan: error strings contain no secrets; no new
  durable content. No hosts or identifiers introduced.
- Implementation plan:
  1. src/providers/common.ts: `isTransportFailure(msg)` (Failed to fetch /
     net::ERR_) and `briefError(msg)` (trim first stack frame group).
  2. src/providers/browser.ts: `withTransportRetry(label, call, {retries,
     backoffMs})` using those helpers; warn-log the brief form, keep throw
     behaviour otherwise.
  3. mimo.ts apiFetch and alibaba.ts gatewayFetch: wrap their `page.evaluate`.
  4. scheduler.ts: record `briefError(result.error)` in the failures map
     (journal line keeps full text).
  5. Unit tests for classifier, trimmer, and retry semantics.
- Validation plan: `npm test`; unit cases — transport error then success →
  2 calls and success; non-transport → 1 call and immediate rethrow; double
  transport → rethrow after 2; briefError trims `at eval (eval at evaluate…`
  and leaves plain messages intact. Live: deploy, watch journal for ≥1h
  (burst hours included) — `Failed to fetch` ERROR lines should drop to
  ~zero while heal-retries warn-log; spot-check a tile's error text if one
  occurs. Same-failure search: any other raw err.message stored for display
  (checked: failures map is the single source).
- Artifact impact plan: AGENTS.md browser-session invariants gain one line
  (transport retry + trimmed display errors). Specs unchanged — metric
  semantics untouched (rendering/reliability of the fetch path only). No
  project skill exists yet; knowledge recorded here. Operator docs unaffected
  (no operator-visible command or behavior change; tiles improve).
- Open decisions: none — user selected option 3 (both fixes) after seeing the
  analysis; retry count 1 and ~750ms backoff follow from the single-cycle
  failure pattern.

## Implementation

- src/providers/common.ts: `isTransportFailure` (Failed to fetch / fetch
  failed / net::ERR_), `briefError` (first line, stack frames cut at
  ` at eval`/`UtilityScript`/`<anonymous>`/`file:line:col`),
  `withTransportRetry` (1 retry, 750ms backoff, both injectable).
  *Deviation from plan:* helpers landed in `common.ts` rather than
  `browser.ts` — they need no playwright, and this keeps the unit tests from
  importing the browser module.
- src/providers/mimo.ts `apiFetch` and src/providers/alibaba.ts
  `gatewayFetch`: their `page.evaluate` calls wrapped in
  `withTransportRetry`.
- src/scheduler.ts: failures map records `briefError(result.error)`; the
  console line keeps the full text.
- AGENTS.md: browser-session invariants gained the transport-retry bullet.

## Validation

- `npm test`: **78 pass** (73 existing + 5 new: classifier true/false
  classes, trimmer keeps plain messages and drops multi-line stacks, retry
  heals on second attempt, never repeats non-transport, gives up after the
  single repeat).
- `npx tsc --noEmit`: one pre-existing error at alibaba.ts:386 (index-type
  looseness in the token-plan resetsAt lookup) — reproduced with these
  changes stashed, unrelated to this SOW, reported to the user, not touched.
- Same-failure search: the failures map is the only place a raw provider
  error string reaches a display surface (db.store runs on success only;
  /api/providers and the MCP read the map via scheduler health) — sanitizing
  it at the source covers every surface.
- Deployed to the daemon host; post-restart polls healthy (see journal below).
- Sensitive-data gate: no secrets, hosts or identifiers in the diff or this
  SOW; test fixtures are synthetic strings.
- Artifact gate: AGENTS.md updated (invariant bullet); specs unchanged —
  metric semantics untouched (fetch reliability + display hygiene only); no
  project skills exist yet (knowledge lives in this SOW + AGENTS.md);
  operator docs unaffected (no command or contract change).
- SOW lifecycle: completed here and moved to done/ in the same commit.
- Deferred-items mapping: none deferred. 24h live follow-up (below) is a
  verification observation of this SOW's own acceptance criteria, not new
  work: `Failed to fetch` ERROR lines in the journal should drop from ~5/hour
  during bursts to ~zero, with `[providers] ... transport failure, retrying`
  warn lines replacing them.

## Outcome

Delivered (2026-10-21): single transient chromium transport failures no
longer cost a poll cycle (one automatic repeat, read-only calls, transport
class only), and tiles/API/MCP show `page.evaluate: TypeError: Failed to
fetch` instead of Playwright's stack junk. Journal keeps full text for
diagnosis.

Lessons:

- Chromium pool/DNS staleness across a fixed idle gap produces a
  same-second, cross-provider, self-healing failure signature — the pattern
  is the diagnosis. Page JS cannot see the `net::ERR_` cause, so every
  transport class gets the same treatment: repeat once.
- Keeping the classifier, trimmer and retry in `common.ts` made the whole
  mechanism unit-testable without a browser — worth preferring for any future
  fetch-path hardening.

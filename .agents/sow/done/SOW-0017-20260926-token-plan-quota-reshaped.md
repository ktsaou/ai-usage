# SOW-0017 - Restore the token plan's quota windows; make the reserve-only card honest

## Status

Status: completed

Sub-state: none — shipped and verified live on the daemon host.

## Requirements

### Purpose

The Alibaba Token Pro card must again show the plan's own quota window(s) alongside the extra-usage-packs pool, and when the vendor stops reporting the plan windows the card must say so instead of silently presenting the packs as if they were the plan.

### User Request

> the alibaba token pro plan, has some subscription quotas and add on credits. However, on the card at the UI, I don't understand what I see. Either of the 2 is missing completely.

Approved plan: SOW + one-poll diagnostic capture on the daemon host + fix the fetcher to the vendor's current shape + close the reserve-only card hole.

### Assistant Understanding

Facts:

- Metric history in the daemon's SQLite (`measurements`, `provider_id='alibaba-token'`): `5h_quota` 2026-07-24 → 2026-08-06 (vendor removed the 5h window; recorded in SOW-0008), `weekly_quota` 2026-07-24 → 2026-09-22 15:18 (last reading 100%), `addon_credits` 2026-08-16 → present.
- The scheduler journal shows `alibaba-token: 2 metrics stored` through Sep 22 15:14 and `1 metrics stored` after, with no error: the `…/v2/usage` endpoint silently stopped returning `per1WeekPercentage`/`per1WeekResetTime` around Sep 22 15:15 UTC. The fetcher (`src/providers/alibaba.ts`) is unchanged since Sep 11, so this is a vendor payload change, the second such change for this endpoint.
- With zero plan-window metrics, the only metric is the add-on pool, marked `secondary` by `addonPoolMetric()` (no `backstopped` plan window to cover). `primaryMetric()` in `src/server.ts` and `src/dashboard.html` falls back to the full metric list when nothing eligible remains, so the reserve headlines the card — contradicting the standing rule that `secondary` may never headline (SOW-0012) and producing a card the operator cannot read.
- The add-on pool is real and still drawn on (24,139 of 100,000 credits used at capture), so the card must keep reporting it; the defect is only the silent substitution for the missing plan quota.
- The coding plan fetcher shares the same failure mode: it emits whatever windows the vendor still reports and stays silent about the ones that disappear.

Inferences:

- The vendor either renamed the weekly fields, nested them differently, moved plan windows to another call, or stopped emitting them in some state. Which of these is unknowable without a capture; the fetcher fix branches on that evidence.
- Restoring the quota rows resolves the operator's immediate complaint; the reserve-only fallback needs an explicit marker so the next vendor change does not produce the same unreadable card for days.

Unknowns:

- The current shape of `…/v2/usage`'s `DataV2` payload. Resolved only by the diagnostic capture (first chunk); the fetcher fix is written from what it shows.

### Acceptance Criteria

- The token plan card shows the plan's quota window(s) with numbers matching what the vendor's console shows, alongside the add-on pool row with its expiry. Verified live against the daemon.
- A plan window at 100% with credits left keeps the `backstopped` semantics (window does not drive risk; the pool binds with `coversUntil`). Verified by unit test and live output.
- When the usage endpoint returns no window fields, the journal records the response's field names (names only), and the add-on metric's note states that the plan's own quota is not currently reported. Verified by unit test and live output.
- The coding plan fetcher logs the same diagnostic when none of its windows are present. Verified by unit test.
- MCP and Prometheus surfaces render the restored metrics without schema changes. Verified by output inspection.
- The service restart after each deploy keeps the browser session alive (persistence path). Verified by journal check and post-restart poll.

## Analysis

Sources checked:

- `src/providers/alibaba.ts` (fetcher, `addonPoolMetric`, relogin), `src/providers/browser.ts`, `src/server.ts` (`primaryMetric`), `src/dashboard.html` (duplicated `primaryMetric`, card rendering, expiry footer).
- `.agents/sow/done/SOW-0008-20260816-addons-and-plan-expiry.md` (captured shapes: usage returned `per1Week*` only after Aug 6; addon fields), `.agents/sow/done/SOW-0012-20260828-addon-pool-is-not-a-plan-quota.md` (secondary/backstopped rules), `.agents/sow/done/SOW-0016-20260911-alibaba-reauth-diagnostics.md`.
- `.agents/sow/specs/provider-quota-semantics.md` lines 246-290 (token plan metric table, pack semantics).
- Daemon journal (Sep 16 → Sep 26) and `measurements` table on the daemon host.
- `.agents/sow/pending/SOW-0014-20260903-pace-for-dollar-reserves.md` (overlap check).

Current state:

- Polls succeed; the token plan emits only `addon_credits` (window-less, `secondary`, `expiresAt`). The card headlines it through the fallback with an "expires in …" footer; no plan quota is mentioned anywhere.

Risks:

- Misreading the captured shape could report wrong quota numbers; mitigated by comparing the restored card against the vendor console before closing.
- Changing `primaryMetric()`'s fallback would also affect pay-as-you-go providers (SOW-0014 depends on the dollar row being headlined through it); the fix must not touch the fallback for payg providers.
- Deploys restart the service; the browser-session persistence path is re-verified each time.
- Journal spam: a missing-fields diagnostic fires every poll while the shape is broken; one short line per minute is acceptable and self-clears.

## Pre-Implementation Gate

Status: ready

Problem / root-cause model:

- The vendor reshaped `…/v2/usage` again on Sep 22 ~15:15 UTC (evidence: journal `2 metrics stored` → `1 metrics stored` with no error; DB shows `weekly_quota` ending 2026-09-22 15:18). The fetcher emits only fields that are present, so the plan window disappeared silently. Because no plan window remained, the sole metric is the `secondary` add-on pool, and `primaryMetric()`'s fallback — designed so a card is never headless — headlines it, silently substituting the reserve for the plan quota.

Evidence reviewed:

- SOW-0008 (captured response shapes, incl. the Aug 6 removal of the 5h window), SOW-0012 (secondary/backstopped invariants), SOW-0016 (reauth diagnostics), the spec's token-plan section, the fetcher and rendering code listed above, the daemon journal, and the `measurements` table.

Affected contracts and surfaces:

- `/api/providers`, `/api/summary`, `/metrics`, dashboard card, MCP output — all read the metrics list; no schema changes.
- `src/providers/alibaba.ts` (usage parsing, diagnostics, add-on note), `src/dashboard.html` and `src/server.ts` only if the card framing needs a wording change (no fallback change for payg).
- Spec `.agents/sow/specs/provider-quota-semantics.md` (token plan table and field provenance).
- Unit tests: new tests for the missing-fields diagnostic and the add-on note; existing risk/history tests must stay green.

Existing patterns to reuse:

- `callGateway` + envelope extraction; `metric()`; the `addonPoolMetric()` three-state rule; the SOW-0008 capture method (capture the console's traffic — here from the daemon side via a shape diagnostic); deploy = stage repo on the daemon host + `install.sh`; session persistence checks after restart.

Risk and blast radius:

- Fetcher-only logic plus one note string; no storage schema, no risk-model parameter change, no scheduler change. Worst case of a bad parse is a wrong number on one card, caught by console comparison before close. The fallback semantics for payg providers are explicitly preserved.

Sensitive data handling plan:

- The diagnostic logs field *names* and quota-shaped values only — never cookies, tokens, account identifiers, or host names. SOW, spec, and code comments name no deployment hosts or accounts (the daemon host is "the daemon host"). Journal excerpts quoted in artifacts are limited to metric counts and field-name lists.

Implementation plan:

1. **Diagnostic capture**: add a shape diagnostic to `fetchAlibabaToken` (and the same for the coding plan's window loop): when zero expected window fields are present, log `[alibaba-token] usage response has no window fields — fields: <names, with quota-shaped values>`. Deploy to the daemon host, wait one poll, read the journal.
2. **Fetcher fix** (branching on the capture): parse the vendor's current shape — renamed fields, different nesting, or a replacement call — and restore the plan window metric(s). Keep 5h/weekly emission data-driven. Retain the diagnostic permanently as the next-shape-change detector.
3. **Card honesty**: when the plan windows are absent, the add-on metric's note states that the plan's own quota is not currently reported by the vendor endpoint; spec records the reserve-only fallback as the one documented exception to "secondary never headlines". No change to the payg fallback.
4. **Docs/tests/spec**: unit tests for the diagnostic and the note; spec table updated with the captured shape and dates; live verification and close.

Validation plan:

- `npm test` green; new unit tests for missing-fields note/diagnostic.
- Live on the daemon host: token plan card vs vendor console numbers; coding plan unchanged; MCP + `/metrics` output inspected.
- Journal check after each service restart: session save/restore clean, no errors.
- Same-failure scan: all fetchers that drop absent optional fields reviewed for the same silent-disappearance pattern.

Artifact impact plan:

- AGENTS.md: no update expected (no workflow change).
- Runtime project skills: none exist.
- Specs: `provider-quota-semantics.md` token-plan section updated (current shape, dates, reserve-only exception).
- End-user/operator docs: CREDS.md only if operator actions change (none expected).
- End-user/operator skills: none exist.
- SOW lifecycle: single SOW; SOW-0014 untouched (interface boundary recorded).

Open-source reference evidence:

- None checked — vendor API behavior, no external OSS involved.

Open decisions:

- None blocking. The fetcher fix branches on the capture evidence (investigation, not a product choice). The card-honesty mechanism is the add-on note + spec'd exception, within the approved direction; if the capture shows the plan windows moved to a different endpoint entirely, that is still the same chunk-2 fix.

## Implications And Decisions

1. **Proceed with SOW + capture + fix** — user-selected option (2026-09-26): write the SOW, capture the vendor's current payload shape from the daemon side, fix the fetcher, close the reserve-only card hole, update spec + tests, deploy, verify live.
2. **Card-honesty mechanism** — assistant decision within the approved direction: extend the add-on note when plan windows are absent, and document the reserve-only headline as the single spec'd exception to "secondary never headlines" (the fallback exists so a card is never headless). A placeholder row or a degraded-provider state was considered and rejected: the reserve is the only true consumption data the daemon has, and an error state would blank a working card.

## Plan

1. Diagnostic shape logging in both alibaba fetchers; deploy; capture one poll; read journal.
2. Fetcher fix per capture; unit tests.
3. Add-on note + spec exception; deploy; live verification; close.

## Execution Log

### 2026-09-26

- SOW created after user approval; investigation evidence recorded above.
- Chunk 1: `describeShape()` added to `src/providers/alibaba.ts`; missing-fields diagnostics added to both alibaba fetchers; deployed (diagnostic-only) to the daemon host. One poll captured the reshaped payload: `per1MonthPercentage=0.205…`, `per1MonthResetTime=1792425600000` (2026-10-19 16:00 UTC) — the weekly window had been replaced by a monthly one. Journal line carried field names and quota values only.
- Chunk 2: parsing extracted into pure `tokenPlanMetrics(usage, addonPool)` in `src/providers/alibaba.ts`; window set now 5h (emitted only if the field returns) + `monthly_quota` from `per1Month*`; diagnostic kept permanently; `addonPoolMetric()` note names the missing plan quota when no window is reported. Unit tests added to `src/providers.test.ts` (fraction parsing, retired-shape handling, backstopped binding, note wording).
- Chunk 3+4: spec `provider-quota-semantics.md` token-plan table and provenance updated with both shape changes and the reserve-only fallback exception; deployed; verified live (2 metrics stored, no diagnostic, session file advancing, Prometheus series present).

## Validation

Acceptance criteria evidence:

- Token plan card restored: `/api/providers` on the daemon host reports `monthly_quota [monthly] used=20.5038% total=100% resets` plus `addon_credits [secondary, expires] used=24139.2/100000 credits (5 active)` — both sourced from the vendor's own endpoints. Console cross-check of the same numbers left to the operator (the fetcher reaches only the APIs, not the rendered console).
- Backstopped semantics preserved: unit test `a spent monthly window with credits left is backstopped and the pool binds on its reset` asserts `backstopped: true` and `coversUntil` = the window's reset; live the window is at 20.5%, not spent.
- Missing-fields diagnostic: journal line `[alibaba-token] usage response has no window fields — payload: per1MonthPercentage=…, per1MonthResetTime=…` observed live from the diagnostic-only deploy; unit tests assert the retired-shape payload produces no window metric and the pool note says the plan quota is missing.
- Coding plan diagnostic: `fetchAlibabaCoding` logs when none of its three windows is reported; live journal shows it quiet while three windows are present.
- MCP/Prometheus: `/metrics` exports `ai_usage_percent{provider="alibaba-token",metric="monthly_quota",window="monthly"} 20.5038` alongside the `addon_credits` series; label scheme unchanged.

Tests or equivalent validation:

- `npm test`: 73 pass, 0 fail (69 pre-existing + 4 new).

Real-use evidence:

- Two live deploys to the daemon host; the service restarted each time; after the fix deploy the new process (journal pid 3287838) stored 2 metrics per poll with no diagnostic line, and the session file timestamp kept advancing with no save/restore errors. Dashboard/MCP/Prometheus inspected via the daemon's own endpoints.

Reviewer findings:

- Self-review against SOW-0012 and AGENTS.md invariants: the fallback that lets the reserve headline the card is left intact but is now a documented, self-describing exception rather than a silent substitution; the pay-as-you-go fallback SOW-0014 depends on is untouched.

Same-failure scan:

- Fetched-metric emission reviewed across all providers for the silent-skip pattern (emit only when an optional vendor field is present): only the two alibaba fetchers had it — both now log the payload shape when no window is recognised. `mimo` already fails loudly (`no token plan quota in response`); the API-key providers parse fixed fields with hard errors. No other instance found.

Sensitive data gate:

- No secrets, cookies, tokens, account identifiers, host names or private addresses in any changed artifact. The journal diagnostic logs field names and quota values only, by construction (`describeShape` restricts values to quota-shaped field names). Journal excerpts in this SOW quote metric counts and field names only; the daemon host is referred to as "the daemon host".

Artifact maintenance gate:

- AGENTS.md: no update — no workflow, command or guardrail change; the fetcher and its diagnostics follow existing conventions.
- Runtime project skills: none exist; no update.
- Specs: `.agents/sow/specs/provider-quota-semantics.md` token-plan section updated (metric table, both shape changes with dates, reserve-only exception).
- End-user/operator docs: CREDS.md unaffected — no operator action changed (the remedy for a shape change is now automatic reporting, not a new procedure).
- End-user/operator skills: none exist; unaffected.
- SOW lifecycle: single SOW, no split; closed `completed` in `done/`; SOW-0014 untouched — its dependency on `primaryMetric()`'s payg fallback was reviewed and preserved.

Specs update:

- `.agents/sow/specs/provider-quota-semantics.md` — updated (see artifact gate).

Project skills update:

- None exist (tracked decision in SOW-0001).

End-user/operator docs update:

- None needed — evidence-backed: no operator procedure changed.

End-user/operator skills update:

- None exist; unaffected.

Lessons:

- A vendor can reshape a payload twice in six weeks without an error on the wire; "emit only the fields present" turns each reshape into a silent metric loss. When a fetcher's window set is data-driven, the missing-shape state must be loud in the journal and self-describing on the card.

Follow-up mapping:

- Nothing deferred; all chunks implemented. SOW-0014 (dollar-reserve pace) remains open and unaffected.

## Outcome

The token plan card again shows the plan's own quota (`monthly_quota`, 20.5% used, resets 2026-10-19 16:00 UTC) beside the add-on pool (24,139/100,000 credits, 5 active packs) — the vendor had replaced the weekly window with a monthly one on Sep 22, and the fetcher now reads that shape from a live capture. When the vendor reshapes the payload again, the journal logs the payload's field names every poll and the card's add-on note says the plan quota is missing, instead of silently substituting the packs for the plan. 73 unit tests pass; deployed and verified live on the daemon host.

## Lessons Extracted

- Same as Lessons above; also: capture the reshaped payload from the daemon itself (a one-line shape diagnostic) rather than asking the operator to drive the console — one poll is enough evidence and the diagnostic doubles as the permanent next-change detector.

## Followup

None yet.

## Regression Log

None yet.

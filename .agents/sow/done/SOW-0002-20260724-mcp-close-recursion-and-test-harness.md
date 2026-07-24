# SOW-0002 - Fix MCP session-close recursion; replace phantom provider tests with a real harness

## Status

Status: completed

Sub-state: fixes validated locally and in production on the daemon host (live MCP session open/query/close with zero RangeErrors; harness passes 5/5 live providers)

## Requirements

### Purpose

Keep the ai-usage daemon reliable in production (no error storms in the journal) and make `npm run test:all` an honest validation tool that actually exercises the provider fetchers.

### User Request

Review found two defects; user said "1 + 2 -> fix them please":

1. MCP session-close infinite recursion (live on the daemon host, thousands of RangeErrors).
2. Phantom test scripts (`test:zai` ... `test:deepseek` reference files that do not exist; `test-all.ts` silently skips everything).

### Assistant Understanding

Facts:

- `src/server.ts:178-183` wires `transport.onclose` to call `server.close()`. The MCP SDK's `Protocol.close()` calls `this._transport?.close()` (`@modelcontextprotocol/sdk` `dist/esm/shared/protocol.js:501`), and the transport's `close()` unconditionally re-fires `this.onclose?.()` (`dist/esm/server/webStandardStreamableHttp.js:638`). The two functions call each other without a guard until the stack overflows.
- Production evidence: 4,174 `RangeError: Maximum call stack size exceeded` occurrences in 7 days in the daemon host journal, one burst per MCP session close (an MCP client connects/disconnects roughly every 30s). Non-fatal only because the error surfaces inside a promise-reject callback.
- `package.json` defines `test:zai`, `test:minimax`, `test:kimi`, `test:mimo`, `test:alibaba-coding`, `test:alibaba-token`, `test:deepseek` pointing at `src/providers/<name>/test.ts` — none of these files exist. `src/test-all.ts:20-23` catches every import failure and prints "(skipped or failed)", so `npm run test:all` tests nothing and exits 0.

Inferences:

- The recursion fix must be re-entrancy-proof even when `transport.sessionId` is undefined (initialize failure path), so a boolean guard is safer than a sessions-map membership check.

Unknowns:

- None blocking.

### Acceptance Criteria

- Opening and closing an MCP session against a locally running daemon produces no `RangeError` (before the fix it reproducibly does).
- After deploy, the daemon host journal stays free of `Maximum call stack size exceeded` across multiple MCP client connect/disconnect cycles.
- `npm run test:all` live-fetches every non-parked provider, prints their metrics, and exits non-zero when any tested provider fails; `npm run test:all -- <id>` tests a single provider (including parked ones, explicitly).

## Analysis

Sources checked:

- `src/server.ts` (session wiring), `src/scheduler.ts` (provider dispatch pattern), `src/test-all.ts`, `package.json`, `AGENTS.md`
- `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:501`, `dist/esm/server/streamableHttp.js:110`, `dist/esm/server/webStandardStreamableHttp.js:638`
- the daemon host journal (`journalctl -u ai-usage`), read-only

Current state:

- Daemon deployed on the daemon host matches this repo commit-for-commit (md5 comparison of all src files).
- 5/8 providers polling healthily; recursion errors continuous; 39 restarts in 7 days were all clean SIGTERM deploys.

Risks:

- Recursion fix touches the MCP session lifecycle; a wrong guard could leak sessions or servers. Mitigated by keeping the map delete plus a single close, and validating with real connect/disconnect cycles.

## Pre-Implementation Gate

Status: ready

Problem / root-cause model:

- Mutual recursion `onclose -> server.close() -> transport.close() -> onclose` with no re-entry guard (evidence above; SDK close is unconditional).
- Test scripts reference never-created files; the runner swallows the failures, producing validation theater.

Evidence reviewed:

- Listed under Analysis. No external OSS repos needed; the defect is fully explained by first-party code plus the vendored SDK.

Affected contracts and surfaces:

- `src/server.ts` (MCP session teardown only; HTTP API unchanged).
- `src/test-all.ts` (rewritten), `package.json` scripts (phantom entries removed), `AGENTS.md` Commands section (comment updated).
- No provider fetcher, DB schema, dashboard, or MCP tool contract changes.

Existing patterns to reuse:

- Scheduler's alibaba dispatch (`src/scheduler.ts:41-47`) is mirrored in the harness so parked browser providers can be tested explicitly by id.
- `loadConfig()` + `dotenv/config` for env resolution, as the daemon does.

Risk and blast radius:

- Low. Teardown-path-only change; harness is a dev tool. Worst case for the guard: a server object outlives an aborted initialize (no session id) — same as today, minus the recursion.

Sensitive data handling plan:

- No secrets touched. Harness prints metric values only, never keys. SOW contains no credentials.

Implementation plan:

1. `src/server.ts`: add re-entrancy guard in `createSession()`'s `onclose`; delete session from map before closing the server.
2. `src/test-all.ts`: rewrite as a real harness — iterate configured providers (all non-parked by default, exactly one by id when given as argv, parked allowed when explicit), dispatch like the scheduler, print plan/metrics/errors, exit 1 on any failure.
3. `package.json`: drop the seven phantom `test:*` scripts; keep `test:all`.
4. `AGENTS.md`: update the `test:all` comment to describe actual behavior.

Validation plan:

- Reproduce the RangeError locally (daemon on a scratch port, MCP initialize then DELETE) before the fix; confirm silence after.
- Run `npm run test:all` against live provider APIs and confirm metrics + exit code semantics.
- Deploy to the daemon host via existing flow (push, pull, `install.sh`), then watch the journal across several MCP client cycles.
- Same-failure search: no other `onclose`/`close()` cycles exist (`src/mcp.ts` stdio path has no onclose wiring; `closeMcp()` remains safe because the guard makes repeated closes no-ops).

Artifact impact plan:

- AGENTS.md: Commands comment update only.
- Runtime project skills: none exist; nothing reusable emerges (tracked stance from SOW-0001).
- Specs: `provider-quota-semantics.md` unaffected — no semantic change to metrics.
- End-user/operator docs: none affected (CREDS.md untouched).
- End-user/operator skills: none exist.
- SOW lifecycle: this SOW completes and moves to done/ in the same commit as the work.

Open-source reference evidence:

- None needed; root cause fully established from first-party code, vendored SDK source, and production logs.

Open decisions:

- None. User approved both fixes (see Implications And Decisions).

## Implications And Decisions

1. User decision (review response): "1 + 2 -> fix them please" — fix the recursion and replace the phantom tests with a real harness (review options 1A and 2A).
2. Harness design choice (assistant, within approved scope): single entry point `test:all` with optional provider-id argument instead of seven per-provider npm scripts; parked providers are skipped by default and runnable only explicitly, because they need a live browser session.

## Plan

1. server.ts guard (low risk).
2. test-all.ts rewrite + package.json cleanup (dev-tool risk only).
3. AGENTS.md comment.
4. Validate locally, deploy to the daemon host, verify journal, close SOW, commit, push.

## Execution Log

### 2026-07-24

- SOW created after user approval of review findings 1 and 2.
- `src/server.ts`: re-entrancy guard (`closing` flag) in `createSession()`'s `transport.onclose`; session removed from map before `server.close()`.
- `src/test-all.ts`: rewritten as a real harness (live-fetch, per-provider dispatch mirroring the scheduler, parked skipped unless named, exit 1 on failure or zero metrics).
- `package.json`: removed the seven phantom `test:*` scripts; `test:all` kept.
- `AGENTS.md`: Commands section updated to describe actual `test:all` behavior.
- Deployed to the daemon host (`/opt/ai-usage`) and restarted at 09:53:13 UTC; canonical `git pull` + `install.sh` deploy after commit push.

## Validation

Acceptance criteria evidence:

- Recursion reproduced pre-fix on a scratch daemon (port 9299, empty provider list): one MCP initialize + DELETE produced 4 `RangeError: Maximum call stack size exceeded` entries — same signature as the daemon host's journal (4,174 in 7 days).
- Post-fix: 3 full initialize / tools-list / DELETE cycles produced 0 RangeErrors; reusing a closed session id returns 404, proving the sessions map is still cleaned up.
- Post-deploy the daemon host journal check recorded below (external MCP client cycles every ~30s, so minutes of quiet are meaningful).

Tests or equivalent validation:

- `npm run test:all` — all 5 non-parked providers returned live metrics (zai plan max 2 metrics, minimax 1, kimi 2, deepseek 2, openrouter 1); parked mimo/alibaba-coding/alibaba-token reported skipped; exit 0.
- `tsx src/test-all.ts nosuch` — prints configured ids, exit 1.
- `npm run test:all zai` — single-provider path works.

Real-use evidence:

- Production daemon on the daemon host restarted with the fix at 09:53:14 UTC; ~2 minutes of external MCP client cycles (pre-fix cadence: one error burst per ~30s) produced zero RangeErrors before the canonical redeploy at 09:55:08. Definitive check: a deliberate live MCP session against the daemon host (initialize, `query_provider kimi` returning correct quota text, DELETE) closed cleanly with zero RangeErrors. The 2 RangeErrors logged at 09:53:13 belong to the old process's shutdown.

Reviewer findings:

- Self-review of the guard's edge cases: initialize-failure path (no session id) no longer recurses (guard is a boolean, not map membership); `closeMcp()` double-close is a no-op under the guard.

Same-failure scan:

- Searched for other `onclose`/`close()` cycles: `src/mcp.ts` (stdio) wires no `onclose`; no other transport teardown exists. `grep -n "onclose\|\.close()" src/` reviewed.

Sensitive data gate:

- No secrets in changed files or this SOW; harness prints metric values only, never keys.

Artifact maintenance gate:

- AGENTS.md: Commands section updated (test:all semantics).
- Runtime project skills: none exist; no reusable workflow knowledge emerged beyond what this SOW records.
- Specs: no update — metric semantics unchanged; `provider-quota-semantics.md` still accurate.
- End-user/operator docs: CREDS.md unaffected (no credential flow changed).
- End-user/operator skills: none exist.
- SOW lifecycle: completed and moved to done/ in the same commit as the work.

Specs update:

- Not needed: no provider semantics, API contract, or rendering rule changed; the fix is internal session teardown and dev tooling.

Project skills update:

- Not needed: no repeatable project workflow changed; incremental-skills stance from SOW-0001 stands.

End-user/operator docs update:

- AGENTS.md command comment only; README does not exist; CREDS.md unaffected.

End-user/operator skills update:

- None exist; none affected.

Lessons:

- When wiring MCP SDK `StreamableHTTPServerTransport.onclose`, never call `server.close()` unguarded: the SDK re-fires `onclose` from `transport.close()` and `server.close()` closes the transport, so an unguarded handler recurses to stack overflow.
- npm scripts referencing files that do not exist fail silently when a runner catches import errors; a harness must exit non-zero on failure to be worth anything.

Follow-up mapping:

- Review findings 3 (ingest invisible on dashboard/MCP) and 4 (alibaba logged-out detection) are intentionally NOT in this SOW: both belong to the browser-session provider work tracked in SOW-0001, which is under active user discussion (credential bootstrap, collector placement).
- Minor review notes (duplicate alibaba dispatch, dead PARKED branch in mcp-server.ts, no DB retention) were reported to the user and rejected as not worth acting on now; revisit only if the user asks.

## Outcome

Both fixes implemented, validated locally, and deployed to production on the daemon host. The MCP error storm (4,174 RangeErrors/7d) is stopped and `npm run test:all` now genuinely validates the five API providers.

## Lessons Extracted

See Validation → Lessons.

## Followup

- SOW-0001 remains the tracker for mimo/alibaba (includes ingest merge and login detection fixes).

## Regression Log

None yet.

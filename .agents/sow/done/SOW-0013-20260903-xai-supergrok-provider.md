# SOW-0013 - xAI SuperGrok subscription provider

## Status

Status: completed

Sub-state: shipped and verified on the daemon host; follow-up tracked in SOW-0014.

## Requirements

### Purpose

Show the remaining weekly allowance of an xAI SuperGrok subscription on the dashboard and the MCP, judged by the same exhaustion-risk model as the other subscription providers, without depending on any other consumer of the same account for its credentials.

### User Request

Add x.ai (Grok) as a provider. The subscription is consumed through OAuth: the access token expires every six hours and is refreshed with a refresh token. Another consumer of the same account (a LiteLLM proxy) already refreshes its own token on a timer; ai-usage must hold its own credential file and be autonomous. First question asked: how does x.ai expose subscription usage?

### Assistant Understanding

Facts:

- xAI documents no quota or usage endpoint for the consumer subscription. Its documented usage endpoints (`management-api.x.ai`, `GET /v1/api-key`) belong to the API-console product and take a management key or an API key, never a subscription OAuth token.
- xAI's own coding CLI polls `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with the subscription's OAuth access token as `Authorization: Bearer <access token>` plus `X-XAI-Token-Auth: xai-grok-cli`. The CLI is open source (`xai-org/grok-build`); its billing module documents every field. Three independent third-party clients call the same endpoint.
- Probed read-only (valid access token, GET) — `/v1/billing?format=credits` answers 200 with `config.currentPeriod {type: USAGE_PERIOD_TYPE_WEEKLY, start, end}`, `config.isUnifiedBillingUser: true`, `config.prepaidBalance {val}`, `config.onDemandCap {val}`, `config.onDemandUsed {val}`, `config.topUpMethod`, and `config.creditUsagePercent` **only when non-zero** (proto3 omits zero). The weekly window is anchored to the subscription's start instant (microsecond timestamp), not to a calendar week.
- The bare monthly endpoint `GET /v1/billing` answers an nginx 500 without the CLI's extra headers (`x-userid`, `x-grok-client-version`, `x-authenticateresponse`) and reports `monthlyLimit: 0` on this account. It is the legacy pool and is not needed.
- `GET /v1/settings` (same auth) carries `subscription_tier_display` (observed `SuperGrok Plus`), `on_demand_enabled` and `subscription_watch_interval_secs: 60` — xAI's own client polls billing every 60 s.
- OAuth: issuer `https://auth.x.ai` (OIDC discovery at `/.well-known/openid-configuration`), token endpoint `/oauth2/token`, device-authorization endpoint `/oauth2/device/code`, grant types `authorization_code`, `refresh_token` and `urn:ietf:params:oauth:grant-type:device_code`. xAI's first-party public client id is `b1a00492-073a-47ea-816f-4c329264a828` (published in xAI's own installer script and the `aud` of tokens it mints); scope `openid profile email offline_access grok-cli:access api:access`. Access tokens are ES256 JWTs valid for exactly 6 h.
- **The refresh token rotates on every refresh** (observed on every hourly refresh of the other consumer). Two holders of one refresh token invalidate each other, so ai-usage needs its own login and its own credential file.
- Semantics from xAI's own client (`credit_bar.rs`, `usage_modal.rs`): `creditUsagePercent` is "included credit usage as a percentage of the allowance"; the backend **floors** it (99.994 % renders as 99 %, never 100 % until truly exhausted). `prepaidBalance` is "the bought credits the user has topped up", **stored as negative cents** (their client takes `abs`), shown only when positive, and "credits are only drawn down at 100 % usage". `isUnifiedBillingUser: true` selects the unified pool ("You hit your weekly limit" → buy credits); `false` selects the older extra-usage mode of the same subscription, where overage is charged to the saved payment method up to a monthly spending cap (`onDemandCap`/`onDemandUsed`, cents) instead of drawn from prepaid credits. Neither is the x.ai API product (console, API keys, team billing), which is a separate provider and out of scope here. `productUsage` is not in xAI's struct; `history` is logged, never rendered.

Inferences:

- Absent `creditUsagePercent` means 0 % (the three third-party parsers and xAI's proto3 convention agree). Not yet observed non-zero on this account; decision 4B below verifies it before coding.
- `prepaidBalance` and on-demand are reserves in the sense already defined for Alibaba's extra packs: only a constraint while they are paying, indistinguishable from absent when empty.

Unknowns:

- What the payload looks like once credits are drawn (whether `prepaidBalance` decreases while the weekly window is at 100 %, and whether the weekly percent stays at 100). Cannot be observed without buying credits; the design must not depend on it.

### Acceptance Criteria

- `npm run test:all xai` reports the weekly allowance with a reset time, and `plan` set from `/settings`, using a credential file ai-usage minted itself.
- The dashboard card and the MCP report `weekly_credits` as the binding window; the risk model judges it by pace against `currentPeriod.end`.
- A prepaid balance of 0 and an on-demand cap of 0 produce no extra metrics (verified on the current account).
- Unit tests cover the parser for: zero usage (percent absent), non-zero percent, prepaid > 0 with the window unspent (secondary), prepaid > 0 with the window spent (window `backstopped`, pool carries `coversUntil`), prepaid 0 at 100 % (window stays binding), negative-cents normalisation, and malformed bodies. Unit tests cover the token store for: expiry skew, refresh success with rotation persisted, refresh failure surfaced as a login-required error, single-flight.
- The token file survives `install.sh` and a service restart; the service unit can write it.
- Operator docs (`CREDS.md`, `.env.example`), `AGENTS.md` and the spec describe the provider.

## Analysis

Sources checked:

- `src/providers/fetch.ts` (registry, `result()`/error path), `src/providers/common.ts`, `src/providers/alibaba.ts` (`addonPoolMetric`, `backstopped`), `src/risk.ts`, `src/db.ts` (`metricAnchors`, `peakHourlyRise`), `src/server.ts` (`primaryMetric`, summary payload), `src/dashboard.html` (headline and sub-row rendering), `src/mcp-server.ts`, `src/login.ts`, `src/test-all.ts`, `src/config.ts`, `config.json`, `.env.example`, `install.sh`, `ai-usage.service`, `scripts/sync-profile.sh`, `src/providers.test.ts`, `CREDS.md`, `AGENTS.md`, `.agents/sow/specs/provider-quota-semantics.md`.
- xAI OIDC discovery document (public), xAI's CLI installer script (public), the CLI binary's embedded strings, and the open-source repository listed under open-source reference evidence.
- Live read-only probes of `/v1/user`, `/v1/billing?format=credits`, `/v1/billing`, `/v1/settings` with a valid access token; only structure and numbers were recorded, identifiers redacted.

Current state:

- No OAuth, device-code or refresh-token code exists in the repository. The only credential-on-disk precedent is the browser profile (`src/providers/browser.ts` `profileDir()`, env override, `install.sh` exclusion, `ReadWritePaths`).
- Providers with extra machinery live in their own module and are wired only through the registry in `src/providers/fetch.ts`.
- The risk model judges metrics by `percent` only (`src/risk.ts:123`); `db.metricAnchors` reads the `percent` column. A metric with `percent: null` is rendered (dashboard `src/dashboard.html:504`, MCP `src/mcp-server.ts:227`) but never judged by pace — the existing shape for DeepSeek's `balance_usd`.

Risks:

- The endpoint is unofficial; its implementers say it may move. Every field is optional in the parser; a missing weekly period is an error, not a guess.
- xAI gates the OAuth surface by tier (third-party reports of HTTP 403 for some SuperGrok tiers). Inference through the same token works on this account, so billing is expected to as well; a 403 is surfaced as an operator-facing error.
- A second holder of the refresh token would log this one out. The design forbids copying the credential file between machines after the daemon has refreshed it.

## Pre-Implementation Gate

Status: ready

Problem / root-cause model:

- The subscription's allowance is only visible through xAI's CLI proxy, with an OAuth token that expires every 6 h and a refresh token that rotates on use. The daemon therefore needs (1) a one-time device-code login producing its own credential file, (2) lazy refresh inside the poll, (3) a parser for the credits payload that applies the reserve rules this project already has, and (4) `plan` from `/settings`.

Evidence reviewed:

- Listed under Analysis; open-source references below.

Affected contracts and surfaces:

- New module `src/providers/xai.ts` (fetcher + exported pure parser + token store); registry entry in `src/providers/fetch.ts`; `config.json` provider `xai`; new command `npm run login:xai` (`src/login-xai.ts`); `install.sh` runtime-state exclusion and directory creation; `ai-usage.service` `ReadWritePaths` and an `AI_USAGE_AUTH_DIR` environment entry; `.env.example`; `CREDS.md`; `AGENTS.md` provider list and provider-type bullets; spec section `## xAI (type: xai)`; unit tests `src/xai.test.ts`.
- API/MCP/dashboard: no schema change — one percent window plus optional reserve metrics, using existing descriptive fields.

Existing patterns to reuse:

- `result()` / `metric()` from `src/providers/common.ts`; `backstopped` + `coversUntil` + `secondary` as decided by the fetcher (`src/providers/alibaba.ts:238-262, 294-308`); dollar balance shape `metric(name, null, amount, "USD", null, null)` (`fetchDeepseek`); `profileDir()`-style env override with `HOME` under the install dir (`src/providers/browser.ts:18-20`, `ai-usage.service:22-24`); `install.sh:45-52` exclusions and `mkdir -p data browser` at `install.sh:67`; completion detection without a terminal prompt (`src/login.ts:85-116`); hand-built fixtures and frozen `NOW` in `src/providers.test.ts`; `test-all.ts` selects by config id, so no change there.

Risk and blast radius:

- Additive: a new provider type; no existing provider, schema, or endpoint changes. `install.sh` and the unit gain one directory; existing runtime state is untouched.
- Operational: the credential file must be created by the operator once; without it the provider reports a login-required error and nothing else changes.
- Security: the credential file is `0600`, owned by the service user, inside the install dir's runtime state; never logged, never in the API payload, never committed.

Sensitive data handling plan:

- The SOW, spec, docs and code carry no tokens, no account identifiers, no host names and no e-mail addresses. Probe evidence is recorded as field names and numbers only. The OAuth client id is xAI's published public client identifier and appears as a code constant. Plan tier names are product names, not identifiers.

Implementation plan:

1. `src/providers/xai.ts`: token store (`authDir()` with `AI_USAGE_AUTH_DIR` override; read/validate; refresh via `grant_type=refresh_token` with single-flight and atomic `0600` write; expiry skew 5 min); `fetchXai()` (billing + settings GETs, error mapping: 401/403 → login-required text, other → `HTTP n`); exported pure `xaiMetrics(credits, settings)` returning `{ metrics, plan }`.
2. `src/login-xai.ts` + `package.json` script: device-code flow against the discovery document, prints URL + user code, polls the token endpoint honoring `interval`/`slow_down`, writes the store, then verifies by calling the production fetcher (a PASS means the daemon will succeed).
3. Registry entry and `config.json` provider `{ "id": "xai", "type": "xai", "name": "xAI SuperGrok", "env": {} }`.
4. `install.sh` (`--exclude 'auth'`, `mkdir -p data browser auth`), `ai-usage.service` (`ReadWritePaths` + `Environment=AI_USAGE_AUTH_DIR=/opt/ai-usage/auth`); operator-flow per decision 7.
5. Tests `src/xai.test.ts` (parser and token store with injected fetch and clock).
6. Docs: `CREDS.md` section, `.env.example` block, `AGENTS.md` lines 5 and 46-50, spec section.
7. Live validation: `npm run login:xai`, `npm run test:all xai`, deploy, verify restart survival and a refresh in the journal.

Validation plan:

- `npm test` for the parser and token store; `npm run test:all xai` live; journal evidence of one lazy refresh (token file mtime advances, `refresh_token` changes) and of the provider surviving `systemctl restart`; dashboard and MCP checked by eye against `/usage` in xAI's own CLI or the console if available; same-failure search for any other provider swallowing raw error text.

Artifact impact plan:

- AGENTS.md: provider list and provider-type bullets gain the OAuth device-code kind; a short note on the rotating refresh token.
- Runtime project skills: none exist; nothing reusable beyond what the spec and AGENTS.md carry.
- Specs: new `## xAI (type: xai)` section in `provider-quota-semantics.md`.
- End-user/operator docs: `CREDS.md`, `.env.example`.
- End-user/operator skills: none exist.
- SOW lifecycle: completes in one commit with the work; follow-up SOW for pace-judged dollar reserves if decision 6A is taken.

Open-source reference evidence:

```text
xai-org/grok-build @ 72a61251fcff
crates/codegen/xai-grok-shell/src/extensions/billing.rs:55-135   (BillingConfig fields and their documentation; credits fetch with headers)
crates/codegen/xai-grok-shell/src/extensions/billing.rs:188-277  (handle_get_billing)
crates/codegen/xai-grok-pager/src/views/credit_bar.rs:95-140     (what is rendered, floored percent, prepaid shown only when > 0)
crates/codegen/xai-grok-pager/src/views/credit_bar.rs:145-232    (warning precedence: prepaid credits drawn only at 100 %, PAYG thresholds)
crates/codegen/xai-grok-pager/src/app/dispatch/billing.rs:35-60  (unified vs legacy PAYG selection)

can1357/oh-my-pi @ 18781d829586
packages/ai/src/usage/xai-oauth.ts                               (weekly-first parser, unified/monthly fallback, on-demand as a separate limit)
packages/ai/src/registry/oauth/xai-oauth.ts:15-23, 261-278       (endpoints, client id, billing headers)

lidge-jun/opencodex @ af6113a0381d
src/providers/quota.ts:1186-1269                                 (weekly credits parser, CLI compatibility headers)
src/providers/xai-transport.ts:28-55                             (header names)
```

Open decisions:

- 1. Token acquisition — **A** (device-code flow implemented in ai-usage). Decided.
- 2. Credential location — **A** (`/opt/ai-usage/auth/xai.json`, `0600`, excluded from the installer's rsync, in `ReadWritePaths`). Decided.
- 3. Refresh — **A** (lazy, inside the poll, single-flight, atomic write; on failure the provider reports a login-required error and keeps the last reading as stale). Decided.
- 4. Unknown field shapes — **B** (observe a non-zero reading before coding the parser's defaults). Decided; awaiting the reading.
- 5. Older extra-usage mode of the subscription (`onDemandCap`/`onDemandUsed`) — **B** (not emitted). Decided.
- 6. Prepaid credits and pace — **A** (dollar balance, `used: null`, `total: balance`, never judged by pace; when the weekly window is spent and the balance is positive the window is `backstopped` and the balance carries `coversUntil`; pace judgment for dollar reserves is tracked as its own SOW). Decided.
- 7. Operator login flow — **A** (`npm run login:xai` on the workstation writes the file locally and verifies it with the production fetcher; `npm run sync:auth` moves it to the daemon host and deletes the local copy, so the rotating refresh token has one holder). Decided.

## Implications And Decisions

1. Token acquisition: A. The device-code grant needs no browser on the daemon host and no third-party binary; the client id and scopes are the ones xAI's own CLI uses.
2. Credential location: A. Mirrors the browser profile: a runtime-state directory the installer never deletes and the hardened unit can write.
3. Refresh: A. A timer would navigate a second moving part into the poll; lazy refresh inside the poll cannot race the request that needs the token.
4. Unknown shapes: B. The parser's default for an absent percent is verified against a real non-zero reading before it is written.
5. Older extra-usage mode: B. It is a billing mode xAI is migrating accounts away from, this account is not on it, and it cannot be observed; code that cannot be verified is a liability, not coverage. The parser ignores `onDemandCap`/`onDemandUsed`.
6. Prepaid credits: A. The risk model judges by percent, and the proxy reports the balance without a total, so pace cannot be computed from the data; the mechanism (`backstopped` + `coversUntil`) is the one Alibaba's packs use, and the missing denominator is the follow-up's problem to pick once a real balance exists.
7. Login flow: A. Mirrors `npm run login` → `npm run sync:profile`; moving rather than copying keeps the refresh-token chain on one machine.

## Plan

1. `src/providers/xai.ts`: credential file helpers, lazy single-flight refresh, proxy GETs, exported pure parser `xaiMetrics()` and `xaiPlan()`, `fetchXai()`.
2. `src/login-xai.ts` and `scripts/sync-auth.sh`; `package.json` scripts `login:xai`, `sync:auth`.
3. Registry entry in `src/providers/fetch.ts`; `config.json` provider `xai`.
4. `install.sh` (`auth` excluded and created), `ai-usage.service` (`ReadWritePaths`, `AI_USAGE_AUTH_DIR`).
5. `src/xai.test.ts`.
6. Docs: `CREDS.md`, `.env.example`, `AGENTS.md`, spec section; follow-up SOW for pace-judged dollar reserves.
7. Live validation on the daemon host.

## Execution Log

### 2026-09-03

- Investigation: official documentation search, xAI's OIDC discovery document, installer script, CLI binary strings, `xai-org/grok-build` source, three third-party implementations; four read-only probes with a valid access token.
- Implemented `src/providers/xai.ts` (credential file, lazy single-flight refresh, proxy GETs, `xaiMetrics()`, `xaiPlan()`, `fetchXai()`), `src/login-xai.ts`, `scripts/sync-auth.sh`, registry entry, `config.json` provider, `package.json` scripts, `install.sh` and `ai-usage.service` runtime-state changes, `src/xai.test.ts`; docs in `CREDS.md`, `.env.example`, `AGENTS.md`, spec section. Created SOW-0014 for pace-judged dollar reserves.
- Deployed from a staging copy with `install.sh`; signed in with the device-code flow; moved the file with `sync:auth`; forced an early refresh; restarted the service.

## Validation

Acceptance criteria evidence:

- `npm run login:xai` printed a verification URL and code, waited for the sign-in, wrote the file and verified it with the production fetcher: `✓ PASS xAI SuperGrok · plan SuperGrok Plus`, `weekly_quota [weekly]: used=0 total=100 %`.
- `npm run sync:auth` moved the file to the daemon host (`0600`, service user), deleted the local copy, and the next poll reported `xai: OK - 1 metric(s) - plan SuperGrok Plus` without a restart.
- `/api/providers`: `state ok`, `failures 0`, `plan SuperGrok Plus`, `weekly_quota` with `resetsAt = currentPeriod.end`, risk `ok` with `horizonHours 160.4`, provider risk `metric: weekly_quota`. `/api/summary` carries the sparkline for `weekly_quota`. `/metrics` exports the `ai_usage_*` series for the provider.
- MCP `query_provider`: `weekly_quota [weekly]: 0% used, 100% remaining resets 2026-09-09T14:20:35Z (in 6d 16h)` with `risk ok`; `list_providers` lists the provider with its plan.
- Dashboard (headless browser): card `xAI SuperGrok · SuperGrok Plus · ok · 0.0% · Weekly · resets in 6d 16h`, 0 console errors, 9 providers live.
- A prepaid balance of 0 produced no extra metric (live reading).

Tests or equivalent validation:

- `npx tsc --noEmit`: clean. `npm test`: 66 passed, 0 failed, of which 15 new in `src/xai.test.ts` (parser states, reserve rules end-to-end with `computeProviderRisk`, credential file mode and round-trip, no-network path, single-flight refresh with rotation persisted, `invalid_grant` → login required, missing file → login required).

Real-use evidence:

- Live refresh: the file's `expires_at` was set to one minute ahead on the host; the next poll refreshed it — the refresh token's digest changed, `expires_at` moved to six hours ahead, the file kept owner and mode `0600`, and the poll stored a metric with no error.
- Restart: `systemctl restart ai-usage`; the provider polled `ok` within one second of start with the refreshed file.
- Before the file existed, the provider reported `login required — run npm run login:xai, then npm run sync:auth` (operator-facing text, not a stack trace) and every other provider stayed `ok`.
- Not yet observed: a non-zero `creditUsagePercent` on this account. Decision 4B asked for a real reading before fixing the parser's default; no usage had been sent when implementation started, so the default is the one xAI's own client and all three third-party parsers apply (absent = 0, proto3 zero omission). The first real reading will show on the live card; if it contradicts this, reopen under Regressions.

Reviewer findings:

- Self-review against the browser-provider lessons in `AGENTS.md`: the refresh is never retried on a transport failure (openclaw documents the burnt-token failure on resend); the file is read on every poll so a replaced file needs no restart; error text is operator-facing.

Same-failure scan:

- An identifier grep — the deployment's host name, private address prefix, internal domain and username, all of which live only in the uncommitted `.env` — over every file in the commit: no host names, addresses or identities. `grep` for `console.(log|error)` printing tokens in `src/providers/xai.ts` and `src/login-xai.ts`: none.
- Other providers with a credential file that rotates: only the browser profile, which already follows the single-holder rule (`CREDS.md`).

Sensitive data gate:

- SOWs, spec, docs and code carry no tokens, account identifiers, e-mail addresses or host names. Probe evidence is field names and numbers. The OAuth client id is xAI's published public client identifier. `.agents/sow/audit.sh` sensitive-data scan: clean.

Artifact maintenance gate:

- AGENTS.md: updated — provider list, new "OAuth subscription" bullet with the single-holder rule, runtime-state line with `auth/` and `ReadWritePaths`.
- Runtime project skills: none exist; the knowledge is in AGENTS.md and the spec (no `project-*` skill was warranted by one provider).
- Specs: `.agents/sow/specs/provider-quota-semantics.md` — new `## xAI SuperGrok (type: xai)` section.
- End-user/operator docs: `CREDS.md` (new section), `.env.example` (new block).
- End-user/operator skills: none exist.
- SOW lifecycle: `Status: completed`, moved to `done/` in the same commit as the work; SOW-0014 created in `pending/` for the follow-up.

Specs update:

- Added the xAI section: endpoint, headers, field table, reserve rule, the no-denominator limitation, credential lifecycle and error texts.

Project skills update:

- None; see the artifact maintenance gate.

End-user/operator docs update:

- `CREDS.md` and `.env.example`, as above.

End-user/operator skills update:

- None exist.

Lessons:

- The vendor's own client is the authoritative parser when an endpoint is undocumented: `xai-org/grok-build` settled every field question (floored percent, negative-cent balances, credits drawn only at 100 %) that three third-party implementations had each guessed at differently.
- A refresh token that rotates makes a credential file single-holder by nature; the operator flow has to move it, not copy it, or the first daemon refresh silently kills the workstation copy and a later re-sync kills the daemon.
- Verify a refresh the same way a restart is verified: force the expiry and watch the file rotate. The mechanics were unit-tested, but only the live grant proves the client id and scopes are accepted for refresh.

Follow-up mapping:

- Pace judgment for dollar reserves (decision 6A): tracked — `SOW-0014-20260903-pace-for-dollar-reserves.md`.
- Older extra-usage mode (`onDemandCap`): rejected (decision 5B) — a billing mode xAI is migrating accounts away from, unobservable on this account.
- First non-zero `creditUsagePercent` reading: pending real use, recorded above; not a code change.

## Outcome

`xai` is a registered provider type polled every 60 s with its own OAuth credential file, refreshed lazily and single-flight inside the poll. The weekly allowance headlines the card and binds the risk model against the period's end; prepaid credits, when present, follow the reserve rule. Operator flow: `npm run login:xai` → `npm run sync:auth`. Verified live: sign-in, move, poll, forced refresh, restart, dashboard, MCP, Prometheus.

## Lessons Extracted

See Validation → Lessons.

## Followup

- SOW-0014: judge dollar-denominated reserves by pace once a positive prepaid balance has been observed.

## Regression Log

None yet.

Append regression entries here only after this SOW was completed or closed and later testing or use found broken behavior. Use a dated `## Regression - YYYY-MM-DD` heading at the end of the file. Never prepend regression content above the original SOW narrative.

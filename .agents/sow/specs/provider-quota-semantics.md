# Spec: Provider Quota Semantics

What each monitored provider's usage API actually reports and how the daemon
interprets it. This is the source of truth for metric names, units, windows,
and reset times. Verified against live raw API responses (2026-07-24) and the
user's plan knowledge.

All subscription providers below report quota on a **0-100 percentage scale**
unless noted as real counts. Percent metrics are emitted with `unit: "%"` and
render in the MCP as `N% used, M% remaining`.

## z.ai (`type: zai`)

Endpoint `GET api.z.ai/api/monitor/usage/quota/limit`, header `Authorization: <key>` (no `Bearer`).
Response `data.limits[]`, plus `data.level` (plan, e.g. `max`).

| API entry | Metric | Unit | Window | Notes |
|---|---|---|---|---|
| `TIME_LIMIT`, `unit: 5` | `monthly_mcp` | `tool calls` | monthly | Real counts: `currentValue`=used, `remaining`, total=`usage` (e.g. 111/4000). `percentage` = percent **used**. Reset = `nextResetTime`. |
| `TOKENS_LIMIT`, `unit: 3` | `5h_quota` | `%` | 5h | Percentage only — no raw counts. `percentage` = percent **used**. Reset = `nextResetTime`. |
| `TOKENS_LIMIT`, `unit: 6` | `weekly_quota` | `%` | weekly | **Not returned on current plans — the weekly bucket is unlimited.** Parser supports it but emits nothing. |

`percentage` means percent-used (confirmed: the MCP entry reports `percentage: 2`
alongside 111/4000 = 2.8% used).

**`monthly_mcp` counts hosted tool calls, not model usage.** The entry carries a
`usageDetails[]` split by `modelCode` — observed values `search-prime`,
`web-reader` and `zread`, summing exactly to `currentValue`. That breakdown is
emitted as the metric's `breakdown`, and both z.ai metrics carry a `note`
saying which one is tool calls and which one is model/LLM usage, because
consumers were reading the monthly tool-call quota as remaining LLM calls.

## MiniMax (`type: minimax`)

Intl `GET api.minimax.io/v1/api/openplatform/coding_plan/remains`; CN `api.minimaxi.com/v1/token_plan/remains`.
Bearer subscription key. Response `model_remains[]` — one entry per model
(`general`, `video`, ...). The daemon uses the active model
(`current_interval_status === 1`, else first).

Per model, two quotas:

- **5h interval** (`current_interval_*`):
  - If `current_interval_total_count > 0` → count-based, unit `requests`.
    Intl: `current_interval_usage_count` is **remaining** (mislabeled by the API);
    CN: it is **used**.
  - Else if `current_interval_status === 1` and `current_interval_remaining_percent`
    present → percent-based, unit `%`, used = `100 - remaining_percent`.
  - **Reset = `end_time`** (the 5h window boundary; `[start_time, end_time]` is
    exactly 5h apart). NOT `remains_time` — that is a long-horizon countdown
    (~50 days) and previously produced a bogus "Sep 21" reset.
- **Weekly** (`current_weekly_*`): same count/percent logic, reset = `weekly_end_time`.
  - **Unlimited on current plans**: `current_weekly_total_count === 0` and
    `current_weekly_status !== 1` → the weekly metric is **skipped** (not shown
    as a fake capped quota).

`*_remaining_percent` fields are percent **remaining** (both regions).

## Kimi (`type: kimi`)

Endpoint `GET api.kimi.com/coding/v1/usages`, Bearer `sk-kimi-...`.
Values are on a 0-100 percentage scale (not token/request counts), unit `%`.
Plan from `user.membership.level` (`LEVEL_STANDARD` → `standard`).

Two quotas — **both are emitted**:

- **Weekly** = top-level `usage` object (`limit`/`used`/`remaining`, reset is
  days out). Emitted as `weekly_quota`, window `weekly`.
- **5h** = the `limits[]` entry whose `window.duration` is 300 minutes. Emitted
  as `5h_quota`, window `5h`, used = `limit - remaining`, reset = `detail.resetTime`.

The top-level `usage` is the weekly quota (its reset is days out); `limits[]`
carries the short windows. A dedup guard keys on the window label so each window
appears once.

## Pay-as-you-go (unchanged)

- **DeepSeek** (`payg: balance`): `GET api.deepseek.com/user/balance`. Lifetime
  USD balance; no reset window.
- **OpenRouter** (`payg: spend`): `GET openrouter.ai/api/v1/credits`. `total_usage`
  is monotonic lifetime spend; 7d spend is derived from stored history. No reset window.

## Browser-session providers

`mimo`, `alibaba-coding`, `alibaba-token` have no usable API key. They are
polled through a shared logged-in chromium profile (`src/providers/browser.ts`):
one persistent context, one tab per provider, each tab navigated once and then
reused, so a poll is a same-origin XHR rather than a page load.

A tab is reused only while it still holds a usable document on the console
origin, which each poll checks by reading `document.cookie` and `location.origin`
inside the page. Anything else — a load that failed while the host's network was
still settling, a crashed renderer, a redirect elsewhere — is re-navigated on the
next poll, so a transient network fault costs one poll instead of requiring a
service restart. The tab's reported URL is not used for this decision: a
navigation that fails after commit leaves it reporting the target URL while the
document is the browser's error page.

Session model (verified 2026-07-24 by inspecting the profile's cookie store):

- **mimo** keeps *persistent* credentials on `account.xiaomi.com` (`passToken`,
  `cUserId`); visiting the console re-mints the short-lived platform token. Its
  session therefore survives browser restarts and the profile copy on its own.
- **alibaba** keeps its console login entirely in *session* cookies, which
  chromium discards on exit. They are saved to `ai-usage-session.json` inside
  the profile and re-injected at launch, refreshed every 5 minutes and on
  shutdown so a restart resumes from current cookies rather than login-time
  ones. Without this the alibaba session dies on every service restart.
- The profile is created on a desktop with `npm run login` and copied to the
  daemon host with `npm run sync:profile`. `--password-store=basic` is required
  on both sides: chromium otherwise encrypts the cookie store with an OS-keyring
  key that does not exist on a headless server.
- When a session does expire, the provider reports
  `session expired — run \`npm run login\`, then \`npm run sync:profile\``.
  Only the raw error surfaces; no partial or stale quota is invented.

### MiMo (`type: mimo`)

Console `platform.xiaomimimo.com/console/balance`.
`GET /api/v1/tokenPlan/usage` → `data.usage.items[]`; the entry named
`plan_total_token` carries `used` / `limit`.
`GET /api/v1/tokenPlan/detail` → `data.planName` (plan, e.g. `Max`) and
`data.currentPeriodEnd`.

| Metric | Unit | Window | Notes |
|---|---|---|---|
| `monthly_credits` | `credits` | monthly | Real counts (e.g. 66.7B of 82B). Reset = `currentPeriodEnd`, which is **Beijing local time without a zone marker** and is parsed as `+08:00`. |

### Alibaba Coding Plan (`type: alibaba-coding`)

Console gateway API
`zeldaEasy.bailian-commerce.codingPlan.queryCodingPlanInstanceInfoV2`
(`commodityCode: sfm_codingplan_public_intl`), field `codingPlanQuotaInfo`.
Plan from `instanceName` (e.g. `Coding Plan Pro`).

| Metric | Unit | Window | Source fields |
|---|---|---|---|
| `5h_quota` | `requests` | 5h | `per5HourUsedQuota` / `per5HourTotalQuota`, reset `per5HourQuotaNextRefreshTime` |
| `weekly_quota` | `requests` | weekly | `perWeek*` equivalents |
| `monthly_quota` | `requests` | monthly | `perBillMonth*` equivalents |

Windows whose total is absent or `<= 0` are **skipped**, not emitted as 0-of-0.

### Alibaba Token Plan (`type: alibaba-token`)

`zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage`; plan from
`.../v2/subscription` → `specCode` (e.g. `pro`).

| Metric | Unit | Window | Source fields |
|---|---|---|---|
| `5h_quota` | `%` | 5h | `per5HourPercentage`, reset `per5HourResetTime` |
| `weekly_quota` | `%` | weekly | `per1WeekPercentage`, reset `per1WeekResetTime` |

Percentages arrive as **0..1 fractions** (percent used) and are multiplied by
100. The gateway answers HTTP 200 even when logged out; session state is read
from `errorCode` (`BailianGateway.Login.NotLogined`), never from a redirect —
the console does not redirect when logged out.

## Cross-cutting rendering

- **MCP percent metrics**: `N% used, M% remaining resets <RFC3339> (in <countdown>)`.
- **Metric self-description**: a metric may carry `note` (what the quota
  actually measures) and `breakdown` (per-item split of `used`). The MCP renders
  them as indented `what this measures:` and `breakdown:` lines under the
  metric. Add a `note` whenever a metric name or unit could be misread as
  something else — the MCP output is consumed by assistants that otherwise
  infer meaning from the name alone. Neither field is stored in SQLite or
  exported to Prometheus; both are descriptive, not historical.
- **MCP countdown** (`resets in …`): units descend `d h m s`; **days is the
  largest unit (no months)**; zero units trimmed; `now` when <= 0. Lifetime
  balances (no reset) show no countdown.
- **MCP reset timestamp**: RFC 3339 UTC, seconds precision (e.g. `2026-07-28T12:59:00Z`).
- **Dashboard headline**: the card's primary metric is the one with the **highest
  percent used** (most exhausted / binding constraint), not a fixed window
  preference. Non-primary metrics render as sub-bars. On Kimi this headlines the
  weekly quota when it is near-exhausted.

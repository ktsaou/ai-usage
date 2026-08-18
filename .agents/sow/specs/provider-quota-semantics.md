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
It is also flagged `secondary`, so it can never headline the card: its percent
used was outranking the 5h model quota (2.8% against 2.0%) and putting a
tool-call number where the plan's usage belongs.

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

Each tab is also revisited every 6 hours (`AI_USAGE_TAB_REFRESH_MS` overrides
the interval), lazily inside that provider's own poll.

Alibaba's console session ends **exactly 48h after sign-in**, measured twice to
the minute, the second time with ~7 page revisits in between and 60s polls
throughout. The lifetime is absolute: neither use, nor revisits, nor restarts
extend it (SOW-0003). The revisit is kept for other purposes, not this one.

The daemon therefore **signs itself in again**: when the gateway reports
`Login.NotLogined` after a forced console reload, it navigates to the login
page's third-party sign-in `href`
(`account.alibabacloud.com/login/third_party_bind_login.htm?type=google&oauth_callback=<console>`),
which completes the OAuth round trip against the identity session stored in the
profile and lands back on the console signed in. The identity session's cookies
are persistent and long-lived (over a year), so the two-day console lifetime is
no longer visible to the operator. Attempts are single-flighted across the two
alibaba providers and rate limited to one per 10 minutes; only when this also
fails does the provider report `session expired and automatic sign-in did not
restore it`, which is the operator's cue to run `npm run login`.

The button on that page cannot be clicked headlessly — an anti-bot overlay
(`baxia-dialog-mask`) covers it — but its `href` works.

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
| `5h_quota` | `requests` | 5h | `per5HourUsedQuota` / `per5HourTotalQuota` — **rolling**, no reset emitted |
| `weekly_quota` | `requests` | weekly | `perWeek*` equivalents, reset `perWeekQuotaNextRefreshTime` |
| `monthly_quota` | `requests` | monthly | `perBillMonth*` equivalents, reset `perBillMonthQuotaNextRefreshTime` |

Windows whose total is absent or `<= 0` are **skipped**, not emitted as 0-of-0.

**The 5h window is a trailing window, not one that resets** (verified over 14 days
of stored history: 511 rises and 515 falls in `per5HourUsedQuota`, and
`per5HourQuotaNextRefreshTime` equal to the server's current time on every one of
~16k samples). It is emitted with `rolling: true`, no `resetsAt`, and a `note`
saying so. Treating its refresh time as a reset made it win every "soonest reset"
comparison with a countdown permanently at zero — the dashboard's next-reset tile
was pinned to it. The weekly and monthly windows are ordinary fixed windows.

### Alibaba Token Plan (`type: alibaba-token`)

Three gateway calls: `…/v2/usage` (quota), `…/v2/addon/summary` (extra packs) and
`…/v2/subscription` (the plan itself — `specCode`, plus the fields under
"Subscription facts" below).

| Metric | Unit | Window | Source fields |
|---|---|---|---|
| `5h_quota` | `%` | 5h | `per5HourPercentage`, reset `per5HourResetTime` |
| `weekly_quota` | `%` | weekly | `per1WeekPercentage`, reset `per1WeekResetTime` |
| `addon_credits` | `credits` | none | `totalCredits` / `remainingCredits`, expiry `nearestExpireTime`, `activeCount` in the note |

Percentages arrive as **0..1 fractions** (percent used) and are multiplied by
100. **The plan no longer has a 5h window**: since 2026-08-06 the usage endpoint
returns only `per1Week*` and the console shows a single 7-day quota. The metric
is emitted only when the field is present, so it simply stopped appearing.

**Extra usage packs** (`addon/summary`, request payload `{}`) are quota bought on
top of the plan. The console spends the plan quota first and then these, stating
"you can continue using the service after reaching the quota" — so a plan window
at 100% with credits left here does **not** stop work. The fetcher therefore
marks such a window `backstopped`, and it is the reason that flag exists. The
add-on metric has no window and does not reset: it carries `expiresAt`
(the nearest pack's expiry), not `resetsAt`.

**The packs are a bridge, and are judged as one.** They are only being drawn on
because a plan window is spent, so the question they answer is *"do they last
until that window resets?"* — after which the plan pays again. The fetcher puts
the soonest spent window's reset on the pool as `coversUntil`, and the risk model
uses it as that metric's deadline, so the ordinary burn-ratio rule applies
unchanged: credits gone before the reset means `crit`. Without it the pool had no
deadline at all and could never be at risk however fast it drained, which is the
one thing it exists to warn about. `coversUntil` is not a reset of the pool and
must not be rendered as one — surfaces say "must last …" / "needs …", and the
metric's `bridging` flag marks the case.

`reset-card/list` also exists (a different kind of top-up) and returns an empty
list; it is deliberately not parsed until a populated sample is available. The gateway answers HTTP 200 even when logged out; session state is read
from `errorCode` (`BailianGateway.Login.NotLogined`), never from a redirect —
the console does not redirect when logged out.

## Exhaustion risk

A percentage says how much is left, not whether it survives the day. These
subscriptions are consumed by a team through a shared gateway, so the pace is
invisible to any one person: measured over 14 days of this deployment's history,
usage is idle 37-74% of hours, while the worst single hour consumed 55% of a 5h
window and 20.8% of a weekly one. Every quota metric therefore carries a `risk`
object, derived in `src/risk.ts` from stored history.

Definitions — all rates are **percent of that quota per hour**, so they compare
across providers whatever the provider counts in:

| Field | Meaning |
|---|---|
| `ratePerHour` | consumption over the last hour |
| `peakRatePerHour` | the largest rise inside any single clock hour of the last 24 |
| `headroomHours` | hours until exhausted at `ratePerHour`; `null` when nothing is burning |
| `peakHeadroomHours` | the same at `peakRatePerHour` — what a resumed burst costs |
| `horizonHours` | hours until the reset; for a rolling window, one window length |
| `burnRatio` | `ratePerHour` over `remaining/horizonHours`; above 1 exhausts before the reset |
| `rolling` | this window decays instead of resetting |
| `level` | `ok` / `warn` / `crit` |

Level rules:

- **crit** — the quota is exhausted, or the rate over the last hour *and* over a
  confirming longer lookback (`min(6h, max(75m, windowLength/4))`) both exceed
  what the quota can afford until its deadline — the reset for an ordinary
  window, one window length for a rolling one, and the covered window's reset
  for a pool that backstops a spent one. Both lookbacks must agree: one busy
  minute otherwise flips a card to red and back, on a page meant to stay open.
- **warn** — the peak hour would exhaust the quota within
  `min(horizonHours, 12h)`. The 12h cap is what makes the peak test meaningful:
  projecting a busy hour across a whole month flags everything, and the question
  being answered is "does this survive tonight".
- The level **never reports better than the raw fill level** (70% elevated, 90%
  critical). An almost-full quota that happens to be idle is not "ok".

Anchors are always constrained to one window instance (`resets_at`), because a
pair spanning a reset reads the drop to zero as a rate. A rolling window has no
reset instant, so its whole history is one instance.

A provider's risk is the risk of the window that binds first: worst level, then
least headroom. `secondary` and `backstopped` quotas keep their own risk but
never speak for the provider — the first measures something else, the second is
spent but covered by another pool. A failed poll leaves the previous risk in
place rather than inventing a reassuring one.

## Subscription facts

A plan that ends takes every quota on it, however healthy those look, so the
plan's own lifetime is part of the risk. Providers that know it report
`subscription` on their result — `endsAt`, `remainingDays`, `autoRenew`,
`status` — which is descriptive, passed through, and never stored. Today both
Alibaba providers report `endTime` / `instanceEndTime`, `remainingDays` and
`status`.

**Renewal state is currently unknown for every provider, on purpose.** Alibaba's
`autoRenewFlag` is not the billing system's renewal state and contradicts it:
measured on the token plan, the field read `false` while the billing action the
console itself uses reported `RenewStatus: AutoRenewal`, a monthly renewal
duration, and the console page displayed "Auto-Renewal Enabled". The billing
action cannot be called by the daemon — it needs a `sec_token` that is not in
`document.cookie`, not on `window.ALIYUN_CONSOLE_CONFIG`, and not in any meta
tag, plus a `collina` anti-bot fingerprint minted by the vendor's scripts. So
`autoRenewFlag` is not read at all and `autoRenew` stays `null`. Do not restore
it without new evidence.

Levels:

- **crit** — `status` is anything other than `VALID`, or the plan ends within
  48h and is **known** not to renew.
- **warn** — it ends within 7 days and is **known** not to renew.
- Auto-renewal **on** clears it: the end date is then bookkeeping.
- Auto-renewal **unknown** says nothing. It used to count as "will not renew",
  on the reasoning that the end date is real either way; that produced a
  confident warning that a renewing plan was about to lapse. A warning nobody
  can act on is worse than no warning.
- Consequence, stated plainly: while no provider can report renewal, this risk
  only ever fires on an invalid status. The end date is still shown everywhere.

The provider's risk is the worse of its binding window and its plan. So a
provider can read `at risk` while every quota on it is healthy; the dashboard's
plan line and the MCP's plan line say why.

Backtested over this deployment's own 14 days: three windows actually reached
100% (kimi 5h, kimi weekly, alibaba-token weekly). The rule above warned before
all three — 75 minutes, 5.4 days and 2.1 days ahead — with no misses, and fired
on 0-1.1% of polled minutes for the 5h windows. Windows where it warned and no
exhaustion followed are mostly cases where the pace really was on track and the
team then eased off, which is what a leading indicator is for; the wording on
every surface is therefore conditional ("at this pace"), never a prediction.

The parameters (1h short lookback, the confirming lookback above, 24h peak
window, 12h planning horizon) were chosen by that backtest. Changing them
without re-running it is guesswork.

## Cross-cutting rendering

- **MCP percent metrics**: `N% used, M% remaining resets <RFC3339> (in <countdown>)`.
- **MCP plan line**: both tools print `plan ends <RFC3339> (in <countdown>) ·
  auto-renewal OFF` for providers that report a subscription, and `status X` when
  the provider calls it anything but `VALID`.
- **Expiry vs reset**: a metric carrying `expiresAt` instead of `resetsAt` renders
  as `expires …` everywhere (MCP line, dashboard card foot, sub-row countdown).
  It is never counted as a reset — the "next quota reset" tile ignores it.
- **MCP burn figures**: `query_provider` adds an indented line per metric —
  `risk <ok|elevated|at risk> · burn N%/h · peak 24h M%/h · headroom Xh · Yh at
  peak pace · burn ratio Z.ZZx`. `list_providers` adds the same line for each
  provider's binding window, prefixed with that window's name and deadline, plus
  one legend line defining burn ratio and headroom. A rate that rounds to zero
  prints `<0.1%/h`; a rate of exactly zero prints `idle` and no headroom. The
  peak-pace headroom is printed only when a resumed burst would actually beat the
  deadline, otherwise it is a large number about nothing. A bridging pool states
  the deadline its ratio is measured against in **both** tools — without it the
  only date on that line is the pack expiry, which is not what the ratio means.
  When the plan's risk outranks every quota on the provider, the plan line says
  so explicitly, since no quota line can. Neither tool ranks
  providers or recommends one: which subscription to use depends on what the
  caller is about to run, so the tools report status only.
- **Metric self-description**: a metric may carry `note` (what the quota
  actually measures), `breakdown` (per-item split of `used`) and `secondary`
  (ineligible for the card headline). The MCP renders
  them as indented `what this measures:` and `breakdown:` lines under the
  metric. Add a `note` whenever a metric name or unit could be misread as
  something else — the MCP output is consumed by assistants that otherwise
  infer meaning from the name alone. None of the three is stored in SQLite or
  exported to Prometheus; they are descriptive, not historical.
- **Durations use one format, everywhere**: at most two units, largest first —
  `45s`, `1m 30s`, `1h 48m`, `3d 4h`; days is the largest unit (no months);
  `now` when <= 0. This covers reset and expiry countdowns, headroom, and the
  plan's remaining time, on every surface. Derived figures used to print as
  decimals (`1.8h`, `8.6d`) while countdowns printed as `1h 28m`, so comparing
  "empty in 1.8h" against "resets in 1h 28m" — the comparison those two numbers
  exist for — required converting one of them. The rule is implemented twice,
  `countdown()` in `src/mcp-server.ts` and `fmtCountdown()` in
  `src/dashboard.html`, because the dashboard has no build step; keep them in
  step. Lifetime balances (no reset) show no countdown, and a headroom of zero
  is rendered as the state (`spent`) rather than as a duration.
- **MCP reset timestamp**: RFC 3339 UTC, seconds precision (e.g. `2026-07-28T12:59:00Z`).
- **Dashboard headline**: the card's primary metric is the one with the **highest
  percent used** (most exhausted / binding constraint), not a fixed window
  preference. Non-primary metrics render as sub-bars. On Kimi this headlines the
  weekly quota when it is near-exhausted.
- **Dashboard risk**: the status chip reads `ok` / `watch` / `at risk` from the
  provider's risk, and the headline number, its bar and every sub-row bar are
  coloured by risk rather than by fill — a green 41% beside an "at risk" chip is
  read as green, and since the risk never reports better than the fill level,
  nothing the colour previously said is lost. Under the bar, a **burn line**
  names the binding window and states the pace and what it leaves:
  `WEEKLY 3%/h now · empty in 19.7h · 11.8h at peak 5%/h`, or
  `5H idle · worst hour 0.7%/h → 5.8d if it resumes`, or `no usage in the last
  24h`. At-risk cards are promoted above healthy ones; within a level the
  configured order is kept, so the page only moves when something changes state.
  Pay-as-you-go cards are ranked by the runway level they actually display, not
  by their burn-rate risk — OpenRouter's `credits` metric carries a percentage
  (lifetime spend against credits purchased), so it has a risk level, but its
  card shows spend and pace instead.
  The overview counters follow the same levels ("lasts to the reset", "a busy
  hour would end it", "runs out at this pace").
- **Headline eligibility**: a metric flagged `secondary` never headlines a card —
  it measures something other than the plan's usage, so its percentage is not
  comparable with the quota windows. Only the provider module sets this; the
  renderers must not infer it from a metric name. Today only z.ai's
  `monthly_mcp` carries it. If every metric of a provider were flagged, the
  selection falls back to the full list so no card is left without a headline.
  The rule is implemented twice — `primaryMetric()` in `src/server.ts` (for
  `/api/summary`) and in `src/dashboard.html` (for the card) — because the
  dashboard has no build step; the two must stay in step.
- **Per-window reset**: every metric row on a card shows its own live countdown,
  not just the headline. A provider is usually capped by several windows at
  once, and the one that blocks work next is frequently not the most exhausted
  one — Alibaba Coding headlines its monthly window while its 5h window resets
  within the hour. Rows whose metric has no reset time (lifetime balances, or a
  window the API reports without one) leave the column blank; the headline says
  `no reset window` explicitly. Countdowns are tagged `data-reset` and updated
  by the page's one-second ticker.
- **Dashboard history**: the page shows a 40-sample sparkline per card and the
  pay-as-you-go runway/spend figures. There are no time-series charts. Both
  inputs come from `GET /api/summary`, which applies the same primary-metric
  rule server-side and returns, per provider: the last 40 values of that metric
  (`percent`, or `total`/`used` for balance/spend providers) and the two
  samples the burn rate is measured between — the newest, and the newest at or
  before `spendWindowDays` earlier, falling back to the oldest sample with
  `sinceFirst: true` when history is shorter than the window. Providers whose
  last poll failed are omitted, so the page keeps showing their previous values.
- **Serving size**: a dashboard refresh is `/api/providers` + `/api/summary`,
  ~2.0 KB gzipped in total over six subscription providers (1.4 KB + 0.6 KB;
  the risk fields are about eight numbers per metric and grew the refresh by
  roughly 0.9 KB). `GET /api/history/:id?days=N` still returns raw samples for
  manual export; nothing polls it.
- **Where risk is computed**: once per poll, in the scheduler, cached in memory.
  The dashboard, `/metrics` and the MCP all read that cache, so the three small
  indexed queries per metric are paid once a minute rather than once per viewer
  per request.
- **Prometheus**: alongside `ai_usage_{percent,used,total,remaining}`, each
  quota metric exports `ai_usage_burn_rate_percent_per_hour`,
  `ai_usage_peak_burn_rate_percent_per_hour`, `ai_usage_burn_ratio`,
  `ai_usage_headroom_hours` and `ai_usage_risk_level` (0 ok, 1 elevated, 2 at
  risk), with the same labels. Headroom is `+Inf` when nothing is burning, so
  the series never disappears exactly when an alert expression needs it.
  Per provider (labels `provider`, `name` only), a plan that reports its lifetime
  also exports `ai_usage_plan_seconds_remaining` and `ai_usage_plan_auto_renew`
  (1/0) — enough to alert on "ends soon and will not renew".
- **Retention**: samples older than `retentionDays` (default 90) are deleted
  once a day. `/metrics` and the MCP read only the latest sample, so retention
  affects export only.

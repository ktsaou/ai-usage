import type { Page } from "patchright";
import type { ProviderConfig, ProviderResult, SubscriptionInfo, UsageMetric } from "../types.js";
import { result, metric } from "./common.js";
import { getPage } from "./browser.js";

const CONSOLE_URL =
  "https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=plan#/efm/subscription/coding-plan";

const GATEWAY = "https://bailian-singapore-cs.alibabacloud.com/data/api.json";

// The console's login page offers a third-party sign-in as a plain link. Going
// straight to that link's href completes the whole OAuth round trip against the
// identity provider session already in the profile, and lands back on the
// console signed in — no form, no clicks. Clicking the button instead does not
// work headlessly: the login page carries an anti-bot overlay
// (`baxia-dialog-mask`) that covers it and swallows the click.
const THIRD_PARTY_LOGIN = `https://account.alibabacloud.com/login/third_party_bind_login.htm?type=google&oauth_callback=${encodeURIComponent(
  CONSOLE_URL
)}`;

export const SESSION_EXPIRED = "session expired — run `npm run login`, then `npm run sync:profile`";
const RELOGIN_FAILED =
  "session expired and automatic sign-in did not restore it — run `npm run login`, then `npm run sync:profile`";

// The console session lasts 48h from sign-in regardless of use (measured twice,
// to the minute, while polls ran throughout). Rather than asking the user to
// sign in every two days, mint a new one from the identity provider's session.
// That session lasts about two weeks, absolutely — measured once, created at
// sign-in and dead to within minutes 14 days later while re-auths used it
// throughout, so use does not extend it. Its cookies read a ~13-month expiry,
// which is the cookie's lifetime, not the session's: the identity provider
// kills the session server-side on its own schedule, and the sign-in landing
// on its account chooser is the tell. Attempts are single-flighted so the two
// providers sharing this console cannot start two sign-ins at once, and rate
// limited so a genuinely dead identity session is not retried every poll.
const RELOGIN_COOLDOWN_MS = 10 * 60 * 1000;
// How long the sign-in gets to settle before the session is judged: the round
// trip lands on the console, whose own scripts may still be minting cookies.
const RELOGIN_SETTLE_MS = 3000;
// A second chance for a landing page that is slow to finish signing in, taken
// only after the first judgement failed, so the ordinary case pays nothing.
const RELOGIN_SETTLE_RETRY_MS = 10000;
let lastReloginAt = 0;
let reloginInFlight: Promise<string | null> | null = null;

/**
 * Where a tab ended up, safe for the journal: origin and path only. The query
 * and fragment are dropped because sign-in redirects carry auth codes, and the
 * title is capped because a page can put anything there.
 */
export function describeLanding(url: string, title: string): string {
  let where: string;
  try {
    const u = new URL(url);
    // An error page has an opaque origin ("null"); its scheme and host still say what it is.
    where = `${u.origin === "null" ? `${u.protocol}//${u.host}` : u.origin}${u.pathname}`;
  } catch {
    where = "(unparseable url)";
  }
  const t = title.replace(/\s+/g, " ").trim().slice(0, 80);
  return t ? `${where} "${t}"` : where;
}

/**
 * Signs in again through the identity provider and resolves to where the tab
 * landed, or null when no sign-in was attempted (cooldown). When the session
 * is still dead afterwards, the landing is the only evidence of why: a challenge
 * page, a consent screen, a changed console entry point all look the same in
 * the gateway's reply and different here.
 */
function relogin(page: Page): Promise<string | null> {
  if (reloginInFlight) return reloginInFlight;
  if (Date.now() - lastReloginAt < RELOGIN_COOLDOWN_MS) return Promise.resolve(null);

  console.log("[alibaba] console session expired — signing in again");
  reloginInFlight = page
    .goto(THIRD_PARTY_LOGIN, { waitUntil: "domcontentloaded", timeout: 60000 })
    .then(() => page.waitForTimeout(RELOGIN_SETTLE_MS))
    .then(async () => describeLanding(page.url(), await page.title().catch(() => "")))
    .catch((err: any) => {
      console.error(`[alibaba] sign-in navigation failed: ${err.message?.split("\n")[0]}`);
      return describeLanding(page.url(), "");
    })
    .finally(() => {
      lastReloginAt = Date.now();
      reloginInFlight = null;
    });
  return reloginInFlight;
}

interface GatewayResponse {
  ok: boolean;
  loggedOut: boolean;
  errorMsg: string | null;
  data: any;
}

async function gatewayFetch(p: Page, api: string, data: Record<string, unknown>): Promise<GatewayResponse> {
  const body = await p.evaluate(
    async ({ gateway, api, data }) => {
      const secToken = document.cookie.match(/sec_token=([^;]+)/)?.[1] || "";
      const params = JSON.stringify({
        Api: api,
        V: "1.0",
        Data: {
          ...data,
          cornerstoneParam: {
            protocol: "V2",
            console: "ONE_CONSOLE",
            productCode: "p_efm",
            domain: "modelstudio.console.alibabacloud.com",
            consoleSite: "MODELSTUDIO_ALBABACLOUD",
            xsp_lang: "en-US",
          },
        },
      });
      const qs = `params=${encodeURIComponent(params)}&region=ap-southeast-1&sec_token=${secToken}`;
      const res = await fetch(
        `${gateway}?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=${api}&_v=undefined`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: qs,
          credentials: "include",
        }
      );
      return res.json().catch(() => null);
    },
    { gateway: GATEWAY, api, data }
  );

  // The gateway answers 200 even when logged out; the session state is in the
  // error code, not in an HTTP status or a redirect.
  const envelope = body?.data;
  const errorCode: string = envelope?.errorCode || "";
  return {
    ok: envelope?.success === true,
    loggedOut: errorCode.includes("Login.NotLogined") || errorCode.includes("NotLogin"),
    errorMsg: envelope?.errorMsg || errorCode || null,
    data: envelope?.DataV2?.data?.data ?? null,
  };
}

/** Runs `api` on the provider's tab, restoring the session if it has lapsed. */
async function callGateway(
  key: string,
  api: string,
  data: Record<string, unknown>
): Promise<GatewayResponse> {
  let page = await getPage(key, CONSOLE_URL);
  let res = await gatewayFetch(page, api, data);
  if (!res.loggedOut) return res;

  // A fresh console load re-mints short-lived session cookies; only a session
  // that has reached its lifetime still fails after the retry.
  page = await getPage(key, CONSOLE_URL, true);
  res = await gatewayFetch(page, api, data);
  if (!res.loggedOut) return res;

  const landing = await relogin(page);
  // The sign-in lands back on the console, so the tab is normally usable
  // already; getPage re-navigates only if it is not.
  page = await getPage(key, CONSOLE_URL);
  res = await gatewayFetch(page, api, data);
  if (!res.loggedOut || landing === null) return res;

  // The sign-in happened and did not take. Say where it landed, then give a
  // slow landing page one longer chance before reporting the operator error.
  console.error(`[alibaba] sign-in did not restore the session — landed on ${landing}`);
  await page.waitForTimeout(RELOGIN_SETTLE_RETRY_MS);
  page = await getPage(key, CONSOLE_URL);
  res = await gatewayFetch(page, api, data);
  console.error(
    res.loggedOut
      ? `[alibaba] still logged out ${RELOGIN_SETTLE_RETRY_MS / 1000}s later — now on ${describeLanding(page.url(), await page.title().catch(() => ""))}`
      : `[alibaba] session restored after a longer wait — the sign-in needs more than ${RELOGIN_SETTLE_MS / 1000}s to settle`
  );
  return res;
}

/**
 * `endTime`/`remainingDays`/`status` are named the same on both plans.
 *
 * `autoRenewFlag` is deliberately **not** read. It is not the billing system's
 * renewal state and can contradict it: measured on the token plan, this field
 * said `false` at the same moment the billing API reported
 * `RenewStatus: AutoRenewal` and the console displayed "Auto-Renewal Enabled".
 * Reporting renewal from it told the user their plan was about to lapse when it
 * was not. The console reads renewal from a billing action the daemon cannot
 * call — it needs a CSRF token that is nowhere in the page and an anti-bot
 * fingerprint minted by the vendor's own scripts — so renewal is left unknown
 * rather than guessed. Do not restore this field without new evidence.
 */
function subscriptionOf(src: any, endKey: string): SubscriptionInfo | null {
  if (!src) return null;
  const endsAt = Number(src[endKey]);
  return {
    endsAt: Number.isFinite(endsAt) && endsAt > 0 ? endsAt : null,
    remainingDays: Number.isFinite(Number(src.remainingDays)) ? Number(src.remainingDays) : null,
    autoRenew: null,
    status: src.status ?? null,
  };
}

export async function fetchAlibabaCoding(config: ProviderConfig): Promise<ProviderResult> {
  try {
    const res = await callGateway(
      config.id,
      "zeldaEasy.bailian-commerce.codingPlan.queryCodingPlanInstanceInfoV2",
      {
        queryCodingPlanInstanceInfoRequest: {
          commodityCode: "sfm_codingplan_public_intl",
          onlyLatestOne: true,
        },
      }
    );
    if (res.loggedOut) return result(config, [], null, RELOGIN_FAILED);
    if (!res.ok) return result(config, [], null, res.errorMsg || "gateway error");

    const info = res.data?.codingPlanInstanceInfos?.[0];
    if (!info) return result(config, [], null, "no coding plan instance found");

    const q = info.codingPlanQuotaInfo || {};
    const metrics: UsageMetric[] = [];
    // The 5h bucket is a *trailing* window, not one that resets: its used count
    // both rises and falls (measured over 14 days of history), and its
    // "next refresh time" is always the server's current time rather than a
    // future instant. Reporting that as a reset made it win every
    // "soonest reset" comparison with a countdown permanently at zero.
    const windows: Array<[string, string, string, string, string, boolean]> = [
      ["5h_quota", "5h", "per5HourUsedQuota", "per5HourTotalQuota", "per5HourQuotaNextRefreshTime", true],
      ["weekly_quota", "weekly", "perWeekUsedQuota", "perWeekTotalQuota", "perWeekQuotaNextRefreshTime", false],
      [
        "monthly_quota",
        "monthly",
        "perBillMonthUsedQuota",
        "perBillMonthTotalQuota",
        "perBillMonthQuotaNextRefreshTime",
        false,
      ],
    ];
    for (const [name, window, usedKey, totalKey, resetKey, rolling] of windows) {
      const total = Number(q[totalKey]);
      if (!Number.isFinite(total) || total <= 0) continue; // unlimited or absent
      metrics.push(
        metric(
          name,
          Number(q[usedKey]) || 0,
          total,
          "requests",
          window,
          rolling ? null : q[resetKey] ?? null,
          rolling ? { rolling: true, note: "trailing 5 hours of usage — this window has no reset, it decays" } : {}
        )
      );
    }

    return result(
      config,
      metrics,
      info.instanceName || info.instanceType || null,
      null,
      subscriptionOf(info, "instanceEndTime")
    );
  } catch (err: any) {
    return result(config, [], null, err.message || "browser fetch failed");
  }
}

/**
 * The extra-pack pool as a metric, or `null` when there is nothing to report.
 *
 * The packs are a **reserve**, not a quota, and a reserve constrains the plan
 * only while it is the thing paying — while a plan window is spent and the
 * packs are covering it. That distinction is invisible to the risk model, which
 * can only apply plan-quota rules: fullness means elevated, and nothing left
 * means at risk. Both are meaningless for a pool nothing is drawing on, so this
 * decides here, where the difference is known.
 *
 * - **No credits left**: no metric. An empty reserve supplies nothing and is
 *   indistinguishable from having bought no packs at all. Emitting it at 100%
 *   made a healthy plan read `at risk` for as long as the pool stayed empty —
 *   the plan window it once covered had already reset and was paying again.
 * - **Credits, covering nothing**: `secondary`. Reported with its numbers and
 *   expiry, but it never headlines a card and never sets the provider's level.
 * - **Credits, covering a spent window**: an ordinary binding metric carrying
 *   `coversUntil`, the soonest covered window's reset — the moment the plan
 *   pays again, and so the deadline these credits have to reach.
 */
export function addonPoolMetric(
  addon: Record<string, unknown> | null,
  planMetrics: UsageMetric[]
): UsageMetric | null {
  const total = Number(addon?.totalCredits);
  const remaining = Number(addon?.remainingCredits);
  if (!addonHasCredits(total, remaining)) return null;

  const covered = planMetrics.filter((m) => m.backstopped);
  const resets = covered.map((m) => Number(m.resetsAt)).filter((t) => Number.isFinite(t) && t > 0);
  const packs = Number(addon?.activeCount);
  const expiresAt = Number(addon?.nearestExpireTime);

  return metric("addon_credits", total - remaining, total, "credits", null, null, {
    note: `extra usage packs${Number.isFinite(packs) ? ` (${packs} active)` : ""} — spent after the plan quota, and they expire rather than reset`,
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
    coversUntil: resets.length ? Math.min(...resets) : null,
    ...(covered.length ? {} : { secondary: true }),
  });
}

/** Credits there are to spend. Packs with nothing left cover nothing. */
function addonHasCredits(total: number, remaining: number): boolean {
  return Number.isFinite(total) && total > 0 && Number.isFinite(remaining) && remaining > 0;
}

export async function fetchAlibabaToken(config: ProviderConfig): Promise<ProviderResult> {
  try {
    const usage = await callGateway(config.id, "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage", {});
    if (usage.loggedOut) return result(config, [], null, RELOGIN_FAILED);
    if (!usage.ok) return result(config, [], null, usage.errorMsg || "gateway error");
    if (!usage.data) return result(config, [], null, "no token plan usage data");

    // Extra usage packs bought on top of the plan. The console spends the plan
    // quota first and then these, and says so ("you can continue using the
    // service after reaching the quota"), so a spent plan window with credits
    // left here does not stop work.
    const addon = await callGateway(
      config.id,
      "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/addon/summary",
      {}
    );
    const packPool = addon.ok ? (addon.data as Record<string, unknown> | null) : null;
    const addonCovers = addonHasCredits(Number(packPool?.totalCredits), Number(packPool?.remainingCredits));

    const metrics: UsageMetric[] = [];
    // Percentages arrive as 0..1 fractions.
    const windows: Array<[string, string, string, string]> = [
      ["5h_quota", "5h", "per5HourPercentage", "per5HourResetTime"],
      ["weekly_quota", "weekly", "per1WeekPercentage", "per1WeekResetTime"],
    ];
    for (const [name, window, pctKey, resetKey] of windows) {
      const fraction = Number(usage.data[pctKey]);
      if (!Number.isFinite(fraction)) continue;
      const percent = fraction * 100;
      // Only once it is actually spent: a window still being consumed is the
      // real constraint, whether or not packs are held in reserve.
      const spent = percent >= 100 && addonCovers;
      metrics.push(
        metric(name, percent, 100, "%", window, usage.data[resetKey] ?? null, {
          ...(spent
            ? { backstopped: true, note: "plan quota spent — usage now comes from the extra packs" }
            : {}),
        })
      );
    }

    // Built from the plan windows above, which already carry `backstopped` and
    // their own reset times, so what the packs are covering is read off them.
    const pool = addonPoolMetric(packPool, metrics);
    if (pool) metrics.push(pool);

    const sub = await callGateway(config.id, "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription", {
      queryInstanceInfoRequest: { commodityCode: "sfm_tokenplansolo_public_intl" },
    });

    return result(
      config,
      metrics,
      sub.ok ? sub.data?.specCode ?? null : null,
      null,
      sub.ok ? subscriptionOf(sub.data, "endTime") : null
    );
  } catch (err: any) {
    return result(config, [], null, err.message || "browser fetch failed");
  }
}

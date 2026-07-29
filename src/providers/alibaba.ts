import type { Page } from "patchright";
import type { ProviderConfig, ProviderResult, UsageMetric } from "../types.js";
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
// sign in every two days, mint a new one from the identity provider's session,
// which lasts about a year. Attempts are single-flighted so the two providers
// sharing this console cannot start two sign-ins at once, and rate limited so a
// genuinely dead identity session is not retried every poll.
const RELOGIN_COOLDOWN_MS = 10 * 60 * 1000;
let lastReloginAt = 0;
let reloginInFlight: Promise<void> | null = null;

function relogin(page: Page): Promise<void> {
  if (reloginInFlight) return reloginInFlight;
  if (Date.now() - lastReloginAt < RELOGIN_COOLDOWN_MS) return Promise.resolve();

  console.log("[alibaba] console session expired — signing in again");
  reloginInFlight = page
    .goto(THIRD_PARTY_LOGIN, { waitUntil: "domcontentloaded", timeout: 60000 })
    .then(() => page.waitForTimeout(3000))
    .catch((err: any) => {
      console.error(`[alibaba] sign-in navigation failed: ${err.message?.split("\n")[0]}`);
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

  await relogin(page);
  // The sign-in lands back on the console, so the tab is normally usable
  // already; getPage re-navigates only if it is not.
  page = await getPage(key, CONSOLE_URL);
  return gatewayFetch(page, api, data);
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
    const windows: Array<[string, string, string, string, string]> = [
      ["5h_quota", "5h", "per5HourUsedQuota", "per5HourTotalQuota", "per5HourQuotaNextRefreshTime"],
      ["weekly_quota", "weekly", "perWeekUsedQuota", "perWeekTotalQuota", "perWeekQuotaNextRefreshTime"],
      [
        "monthly_quota",
        "monthly",
        "perBillMonthUsedQuota",
        "perBillMonthTotalQuota",
        "perBillMonthQuotaNextRefreshTime",
      ],
    ];
    for (const [name, window, usedKey, totalKey, resetKey] of windows) {
      const total = Number(q[totalKey]);
      if (!Number.isFinite(total) || total <= 0) continue; // unlimited or absent
      metrics.push(metric(name, Number(q[usedKey]) || 0, total, "requests", window, q[resetKey] ?? null));
    }

    return result(config, metrics, info.instanceName || info.instanceType || null);
  } catch (err: any) {
    return result(config, [], null, err.message || "browser fetch failed");
  }
}

export async function fetchAlibabaToken(config: ProviderConfig): Promise<ProviderResult> {
  try {
    const usage = await callGateway(config.id, "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage", {});
    if (usage.loggedOut) return result(config, [], null, RELOGIN_FAILED);
    if (!usage.ok) return result(config, [], null, usage.errorMsg || "gateway error");
    if (!usage.data) return result(config, [], null, "no token plan usage data");

    const metrics: UsageMetric[] = [];
    // Percentages arrive as 0..1 fractions.
    const windows: Array<[string, string, string, string]> = [
      ["5h_quota", "5h", "per5HourPercentage", "per5HourResetTime"],
      ["weekly_quota", "weekly", "per1WeekPercentage", "per1WeekResetTime"],
    ];
    for (const [name, window, pctKey, resetKey] of windows) {
      const fraction = Number(usage.data[pctKey]);
      if (!Number.isFinite(fraction)) continue;
      metrics.push(metric(name, fraction * 100, 100, "%", window, usage.data[resetKey] ?? null));
    }

    const sub = await callGateway(config.id, "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription", {
      queryInstanceInfoRequest: { commodityCode: "sfm_tokenplansolo_public_intl" },
    });

    return result(config, metrics, sub.ok ? sub.data?.specCode ?? null : null);
  } catch (err: any) {
    return result(config, [], null, err.message || "browser fetch failed");
  }
}

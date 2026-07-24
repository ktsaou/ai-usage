import type { Page } from "patchright";
import type { ProviderConfig, ProviderResult, UsageMetric } from "../types.js";
import { result, metric } from "./common.js";
import { getPage } from "./browser.js";
import { SESSION_EXPIRED } from "./alibaba.js";

const CONSOLE_URL = "https://platform.xiaomimimo.com/console/balance";
const ORIGIN = "https://platform.xiaomimimo.com";

interface ApiResponse {
  status: number;
  body: any;
}

async function apiFetch(p: Page, path: string): Promise<ApiResponse> {
  // Logged out, the console redirects to the account domain, where this call
  // would be cross-origin. Report that as an auth failure, not a fetch crash.
  if (!p.url().startsWith(ORIGIN)) return { status: 401, body: null };

  return p.evaluate(async ({ origin, path }) => {
    const res = await fetch(`${origin}${path}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, { origin: ORIGIN, path });
}

function loggedOut(res: ApiResponse): boolean {
  if (res.status === 401 || res.status === 403) return true;
  // The console also reports auth failures inside a 200 envelope.
  const code = res.body?.code;
  return code === 401 || code === 403 || /not.?login|unauthor/i.test(String(res.body?.message ?? ""));
}

export async function fetchMimo(config: ProviderConfig): Promise<ProviderResult> {
  try {
    let page = await getPage(config.id, CONSOLE_URL);
    let usage = await apiFetch(page, "/api/v1/tokenPlan/usage");
    if (loggedOut(usage)) {
      page = await getPage(config.id, CONSOLE_URL, true);
      usage = await apiFetch(page, "/api/v1/tokenPlan/usage");
    }
    if (loggedOut(usage)) return result(config, [], null, SESSION_EXPIRED);
    if (usage.status !== 200) return result(config, [], null, `HTTP ${usage.status}`);

    const detail = await apiFetch(page, "/api/v1/tokenPlan/detail");

    const metrics: UsageMetric[] = [];
    const items = usage.body?.data?.usage?.items || [];
    for (const item of items) {
      const limit = Number(item.limit);
      if (item.name !== "plan_total_token" || !Number.isFinite(limit) || limit <= 0) continue;
      const periodEnd = detail.body?.data?.currentPeriodEnd;
      // Console timestamps are Beijing local time without a zone marker.
      const resetsAt = periodEnd ? new Date(String(periodEnd).replace(" ", "T") + "+08:00").getTime() : null;
      metrics.push(
        metric("monthly_credits", Number(item.used) || 0, limit, "credits", "monthly", resetsAt)
      );
    }
    if (metrics.length === 0) return result(config, [], null, "no token plan quota in response");

    return result(config, metrics, detail.body?.data?.planName ?? null);
  } catch (err: any) {
    return result(config, [], null, err.message || "browser fetch failed");
  }
}

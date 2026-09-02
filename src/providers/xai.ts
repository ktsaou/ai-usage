import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderConfig, ProviderResult, UsageMetric } from "../types.js";
import { metric, result } from "./common.js";

/**
 * xAI SuperGrok subscription.
 *
 * xAI documents no usage endpoint for the consumer subscription. Its own coding
 * CLI reads the weekly allowance from the CLI proxy with the subscription's
 * OAuth access token, and this fetcher does the same: same public client id,
 * same scopes, same header that tells the proxy to validate a CLI session
 * (xai-org/grok-build, crates/codegen/xai-grok-shell/src/extensions/billing.rs).
 * The field semantics are in the spec.
 *
 * The daemon holds its own credential file. The refresh token rotates on every
 * refresh, so two holders of one file log each other out: the file is never
 * shared with another consumer of the account, and never copied back from the
 * daemon host once the daemon has refreshed it.
 */

export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
/** xAI's first-party CLI client, published in its installer script. */
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_PROXY = "https://cli-chat-proxy.grok.com/v1";
const REQUEST_TIMEOUT_MS = 15000;
/** Refresh this long before expiry, so a token is never sent in its last seconds. */
const EXPIRY_SKEW_MS = 5 * 60000;

export const LOGIN_REQUIRED = "login required — run `npm run login:xai`, then `npm run sync:auth`";

export const TOKEN_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
};

export interface XaiAuth {
  access_token: string;
  refresh_token: string;
  /** Epoch milliseconds. */
  expires_at: number;
  token_endpoint: string;
}

export function authDir(): string {
  return process.env.AI_USAGE_AUTH_DIR || join(homedir(), ".local", "share", "ai-usage", "auth");
}

export function authFile(): string {
  return join(authDir(), "xai.json");
}

export function readAuth(path: string): XaiAuth | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf-8"));
  const ok =
    typeof data?.access_token === "string" &&
    typeof data?.refresh_token === "string" &&
    typeof data?.expires_at === "number" &&
    typeof data?.token_endpoint === "string";
  if (!ok) throw new Error(`${path} is not an xai credential file`);
  return data as XaiAuth;
}

/** Private and atomic: mode 0600, written beside the target and renamed over it. */
export function writeAuth(path: string, auth: XaiAuth): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** The credential record for a token endpoint reply, from a login or a refresh. */
export function authFromTokenResponse(body: unknown, tokenEndpoint: string, now = Date.now()): XaiAuth {
  const b = body as Record<string, unknown> | null;
  if (typeof b?.access_token !== "string" || !b.access_token) throw new Error("token reply has no access_token");
  if (typeof b?.refresh_token !== "string" || !b.refresh_token) throw new Error("token reply has no refresh_token");
  const expiresIn = Number(b.expires_in);
  const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
  return {
    access_token: b.access_token,
    refresh_token: b.refresh_token,
    expires_at: now + ttl * 1000,
    token_endpoint: tokenEndpoint,
  };
}

/** What the token store needs from the outside world; tests inject both. */
export interface TokenDeps {
  fetch: typeof fetch;
  now: () => number;
}

const inflight = new Map<string, Promise<string>>();

/**
 * A valid access token from the credential file, refreshing first when it is
 * about to expire. The file is read on every call, so one replaced by
 * `sync:auth` is picked up by the next poll without a restart.
 */
export async function accessToken(path: string, deps: TokenDeps = { fetch, now: Date.now }): Promise<string> {
  const auth = readAuth(path);
  if (!auth) throw new Error(LOGIN_REQUIRED);
  if (auth.expires_at - deps.now() > EXPIRY_SKEW_MS) return auth.access_token;

  // One refresh at a time per file: the refresh token is single-use, and two
  // concurrent refreshes would burn it and log the daemon out.
  let pending = inflight.get(path);
  if (!pending) {
    pending = refresh(path, auth, deps).finally(() => inflight.delete(path));
    inflight.set(path, pending);
  }
  return pending;
}

async function refresh(path: string, auth: XaiAuth, deps: TokenDeps): Promise<string> {
  // Never retried on a transport failure: the server may have consumed the
  // refresh token before the reply was lost, and a resend would burn it.
  const res = await deps.fetch(auth.token_endpoint, {
    method: "POST",
    headers: TOKEN_HEADERS,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh_token,
      client_id: XAI_OAUTH_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // invalid_grant: revoked, or consumed by another holder of the file.
    const code = (body as { error?: unknown } | null)?.error;
    throw new Error(
      code === "invalid_grant" ? LOGIN_REQUIRED : `token refresh failed: HTTP ${res.status}${code ? ` ${code}` : ""}`
    );
  }
  const next = authFromTokenResponse(body, auth.token_endpoint, deps.now());
  writeAuth(path, next);
  return next.access_token;
}

interface ProxyReply {
  body: unknown;
  error: string | null;
}

async function proxyGet(path: string, token: string): Promise<ProxyReply> {
  const res = await fetch(`${XAI_PROXY}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "X-XAI-Token-Auth": "xai-grok-cli" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401) return { body: null, error: LOGIN_REQUIRED };
  // xAI decides which accounts may use the CLI surface at all.
  if (res.status === 403) return { body: null, error: "account not allowed on xAI's CLI surface (HTTP 403)" };
  if (!res.ok) return { body: null, error: `HTTP ${res.status}` };
  return { body: await res.json(), error: null };
}

export async function fetchXai(config: ProviderConfig): Promise<ProviderResult> {
  let token: string;
  try {
    token = await accessToken(authFile());
  } catch (err: any) {
    return result(config, [], null, err.message || "credential file unreadable");
  }

  const [credits, settings] = await Promise.all([
    proxyGet("/billing?format=credits", token),
    proxyGet("/settings", token),
  ]);
  if (credits.error) return result(config, [], null, credits.error);
  // The tier name is decoration; a failed settings call must not fail the poll.
  return result(config, xaiMetrics(credits.body), settings.error ? null : xaiPlan(settings.body));
}

/** Dollars from the proxy's `{val: cents}` money shape. Balances arrive as negative cents. */
function dollars(value: unknown): number {
  const cents = Number((value as { val?: unknown } | null)?.val);
  return Number.isFinite(cents) ? Math.abs(cents) / 100 : 0;
}

/**
 * Metrics from `GET /billing?format=credits`.
 *
 * The weekly allowance is the plan's quota and always headlines. Prepaid
 * credits are extra usage bought on top of it, drawn only once the allowance is
 * spent — a reserve in the sense `addonPoolMetric()` defines for Alibaba's
 * packs: not emitted while empty, `secondary` while nothing draws on it, and the
 * thing paying (with the allowance `backstopped`) once the week is at 100%. They
 * are a dollar balance with no known total, so they carry no percent and the
 * risk model never judges them by pace.
 */
export function xaiMetrics(body: unknown): UsageMetric[] {
  const config = (body as { config?: Record<string, unknown> } | null)?.config;
  if (!config || typeof config !== "object") throw new Error("billing reply has no config");

  const period = config.currentPeriod as { type?: unknown; end?: unknown } | undefined;
  const type = typeof period?.type === "string" ? period.type : "";
  const end = typeof period?.end === "string" ? Date.parse(period.end) : NaN;
  if (!type.includes("WEEKLY") || !Number.isFinite(end)) {
    throw new Error(`billing reply has no weekly period${type ? ` (${type})` : ""}`);
  }

  // proto3 omits a zero, so an absent percent is 0% used — the reading every
  // client of this endpoint makes, xAI's own included. The backend floors it,
  // so 100 means truly exhausted.
  const raw = config.creditUsagePercent;
  const percent = raw === undefined || raw === null ? 0 : Number(raw);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("billing reply has an unreadable creditUsagePercent");
  }

  const prepaid = dollars(config.prepaidBalance);
  const spent = percent >= 100 && prepaid > 0;
  const metrics = [
    metric(
      "weekly_quota",
      percent,
      100,
      "%",
      "weekly",
      end,
      spent ? { backstopped: true, note: "weekly allowance spent — usage now comes from the prepaid credits" } : {}
    ),
  ];
  if (prepaid > 0) {
    metrics.push(
      metric("prepaid_credits", null, prepaid, "USD", null, null, {
        note: "extra usage bought on top of the plan — drawn only after the weekly allowance is spent",
        coversUntil: spent ? end : null,
        ...(spent ? {} : { secondary: true }),
      })
    );
  }
  return metrics;
}

/** The plan's display name from `GET /settings`, e.g. `SuperGrok Plus`. */
export function xaiPlan(body: unknown): string | null {
  const tier = (body as { subscription_tier_display?: unknown } | null)?.subscription_tier_display;
  return typeof tier === "string" && tier.trim() ? tier.trim() : null;
}

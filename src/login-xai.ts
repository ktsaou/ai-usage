// Signs in to xAI with the OAuth device-code grant and writes the credential
// file the daemon refreshes on its own. Nothing here needs a browser on this
// machine: it prints a URL and a code, and polls until the sign-in completes
// wherever the user opens it. Verification calls the production fetcher, so a
// PASS means the daemon will succeed with this file — not merely that a token
// was issued.
import { loadConfig } from "./config.js";
import { fetchProvider } from "./providers/fetch.js";
import {
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_ISSUER,
  XAI_OAUTH_SCOPE,
  TOKEN_HEADERS,
  authFile,
  authFromTokenResponse,
  writeAuth,
  type XaiAuth,
} from "./providers/xai.js";

const REQUEST_TIMEOUT_MS = 15000;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: TOKEN_HEADERS,
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const config = loadConfig();
const cfg = config.providers.find((p) => p.type === "xai");
if (!cfg) fail("no provider of type xai in config.json");

// Endpoints come from discovery, and must stay on the issuer: the reply names
// where the refresh token will be sent for the lifetime of the file.
const discovery = await (
  await fetch(`${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
).json();
const deviceEndpoint: unknown = discovery?.device_authorization_endpoint;
const tokenEndpoint: unknown = discovery?.token_endpoint;
for (const url of [deviceEndpoint, tokenEndpoint]) {
  if (typeof url !== "string" || !url.startsWith(`${XAI_OAUTH_ISSUER}/`)) fail("xAI discovery did not return its device-code endpoints");
}

const device = await postForm(deviceEndpoint as string, { client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE });
if (device.status !== 200 || typeof device.body?.device_code !== "string" || typeof device.body?.user_code !== "string") {
  fail(`device-code request failed: HTTP ${device.status}${device.body?.error ? ` ${device.body.error}` : ""}`);
}
const expiresIn = Math.max(Number(device.body.expires_in) || 600, 60);
let interval = Math.max(Number(device.body.interval) || 5, 1) * 1000;

console.log(`\nOpen   ${device.body.verification_uri_complete || device.body.verification_uri}`);
console.log(`Code   ${device.body.user_code}\n`);
console.log(`Sign in with the account that holds the SuperGrok subscription. Waiting (up to ${Math.round(expiresIn / 60)} min)…`);

let auth: XaiAuth | null = null;
const deadline = Date.now() + expiresIn * 1000;
while (Date.now() < deadline) {
  await sleep(interval);
  const poll = await postForm(tokenEndpoint as string, {
    grant_type: DEVICE_GRANT,
    client_id: XAI_OAUTH_CLIENT_ID,
    device_code: device.body.device_code,
  });
  if (poll.status === 200) {
    auth = authFromTokenResponse(poll.body, tokenEndpoint as string);
    break;
  }
  const code = poll.body?.error;
  if (code === "authorization_pending") continue;
  if (code === "slow_down") {
    interval += 5000;
    continue;
  }
  if (code === "access_denied" || code === "authorization_denied") fail("the sign-in was denied");
  if (code === "expired_token") fail("the code expired before the sign-in completed — run the login again");
  fail(`token exchange failed: HTTP ${poll.status}${code ? ` ${code}` : ""}`);
}
if (!auth) fail("timed out waiting for the sign-in — run the login again");

writeAuth(authFile(), auth);
console.log(`\n✓ credentials written to ${authFile()}`);

const r = await fetchProvider(cfg!);
if (r.error || r.metrics.length === 0) fail(`FAIL  ${cfg!.name}: ${r.error || "no metrics"}`);
console.log(`✓ PASS  ${cfg!.name}${r.plan ? ` · plan ${r.plan}` : ""}`);
for (const m of r.metrics) {
  console.log(`    ${m.name} [${m.window}]: used=${m.used} total=${m.total} ${m.unit}`);
}
console.log("\nVerified. Next: npm run sync:auth");

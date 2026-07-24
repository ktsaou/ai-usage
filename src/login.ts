import { chromium, type Page } from "patchright";
import "dotenv/config";
import { loadConfig } from "./config.js";
import {
  profileDir,
  LAUNCH_ARGS,
  useContext,
  adoptPage,
  setPassive,
  saveSession,
  closeBrowser,
} from "./providers/browser.js";
import { fetchProvider } from "./providers/fetch.js";
import type { ProviderConfig } from "./types.js";

// Headed login for the browser-session providers. Opens one tab per site in a
// single shared profile, then watches those tabs passively: it never opens or
// navigates anything while the user is signing in. When every session works,
// it prints the live quotas and closes the window by itself.
// Afterwards the profile is copied to the daemon host with `npm run sync:profile`.

const SITES: Array<{ providerIds: string[]; label: string; url: string }> = [
  {
    providerIds: ["mimo"],
    label: "MiMo — sign in with your Xiaomi account",
    url: "https://platform.xiaomimimo.com/console/balance",
  },
  {
    // Both alibaba plans read the same console, so they share one tab.
    providerIds: ["alibaba-coding", "alibaba-token"],
    label: "Alibaba Model Studio — sign in with Google",
    url: "https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=plan#/efm/subscription/coding-plan",
  },
];

const TIMEOUT_MS = Number(process.env.AI_USAGE_LOGIN_TIMEOUT || "1800") * 1000;
const POLL_MS = 5000;

const config = loadConfig();
const byId = new Map(config.providers.map((p) => [p.id, p]));
// Verification reuses the production fetchers, so a PASS means the daemon will
// succeed with this profile — not merely that a page looked logged in.
const checks: Array<{ id: string; label: string; cfg: ProviderConfig }> = (
  [
    ["mimo", "MiMo"],
    ["alibaba-coding", "Alibaba Coding Plan"],
    ["alibaba-token", "Alibaba Token Plan"],
  ] as const
)
  .map(([id, label]) => ({ id, label, cfg: byId.get(id)! }))
  .filter((c) => c.cfg);

const dir = profileDir();
console.log(`Profile: ${dir}\n`);

const context = await chromium.launchPersistentContext(dir, { headless: false, args: LAUNCH_ARGS });
useContext(context);

let windowGone = false;
context.on("close", () => {
  windowGone = true;
});

const tabs: Page[] = [];
for (const [i, site] of SITES.entries()) {
  const page = i === 0 ? context.pages()[0] || (await context.newPage()) : await context.newPage();
  await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  for (const id of site.providerIds) adoptPage(id, page);
  tabs.push(page);
}

// From here on, probing may only read the tabs the user is working in.
setPassive(true);

console.log("A browser window is open with one tab per site:\n");
for (const site of SITES) console.log(`  • ${site.label}`);
console.log("\nSign in to both. Nothing will open or navigate while you do —");
console.log("the window closes by itself once every session works.\n");

const passed = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const start = Date.now();
let lastStatus = "";

while (!windowGone && Date.now() - start < TIMEOUT_MS && passed.size < checks.length) {
  await sleep(POLL_MS);
  if (windowGone) break;

  for (const check of checks) {
    if (passed.has(check.id)) continue;
    const r = await fetchProvider(check.cfg);
    if (!r.error && r.metrics.length > 0) {
      passed.add(check.id);
      console.log(`✓ ${check.label}${r.plan ? ` · plan ${r.plan}` : ""}`);
      for (const m of r.metrics) {
        console.log(`    ${m.name} [${m.window}]: used=${m.used} total=${m.total} ${m.unit}`);
      }
    }
  }

  // Only the origin, never the full URL: sign-in redirects carry auth codes.
  const where = tabs
    .map((t) => {
      try {
        return new URL(t.url()).host;
      } catch {
        return "?";
      }
    })
    .join(", ");
  const status = `waiting for: ${checks.filter((c) => !passed.has(c.id)).map((c) => c.label).join(", ")} | tabs: ${where}`;
  if (status !== lastStatus) {
    console.log(`  … ${status}`);
    lastStatus = status;
  }
}

console.log("");
for (const check of checks) console.log(`${passed.has(check.id) ? "✓ PASS" : "✗ FAIL"}  ${check.label}`);

if (windowGone) {
  console.log("\nBrowser window was closed before every session was verified.");
} else {
  // Must happen before the window closes: the alibaba console keeps its login
  // in session cookies, which chromium discards on exit.
  const saved = await saveSession();
  console.log(`\nSaved ${saved} session cookie(s) for the daemon.`);
  await closeBrowser();
}

if (passed.size === checks.length) {
  console.log("\nAll sessions verified. Next: npm run sync:profile");
  process.exit(0);
}
console.log("\nRe-run `npm run login` and complete the remaining sign-ins.");
process.exit(1);

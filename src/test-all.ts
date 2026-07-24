import { loadConfig } from "./config.js";
import { fetchProvider } from "./providers/fetch.js";
import { closeBrowser } from "./providers/browser.js";

// Live-fetches every non-parked provider and reports metrics.
// A single provider id as argument tests just that one — including parked
// providers, which are skipped by default because they need a browser session.
const only = process.argv[2];
const config = loadConfig();

const targets = only ? config.providers.filter((p) => p.id === only) : config.providers;
if (only && targets.length === 0) {
  console.error(`unknown provider id: ${only}`);
  console.error(`configured: ${config.providers.map((p) => p.id).join(", ")}`);
  process.exit(1);
}

let failures = 0;

for (const p of targets) {
  console.log(`\n${"=".repeat(60)}\n  ${p.id} (${p.type})\n${"=".repeat(60)}`);
  if (p.parked && !only) {
    console.log("  parked — skipped (needs a browser session; test explicitly by id)");
    continue;
  }
  const r = await fetchProvider(p);
  if (r.error) {
    failures++;
    console.log(`  ERROR: ${r.error}`);
    continue;
  }
  if (r.metrics.length === 0) {
    failures++;
    console.log("  FAIL: no metrics returned");
    continue;
  }
  if (r.plan) console.log(`  plan: ${r.plan}`);
  for (const m of r.metrics) {
    const reset = m.resetsAt ? ` resets ${new Date(m.resetsAt).toISOString()}` : "";
    console.log(
      `  ${m.name} [${m.window || "n/a"}]: used=${m.used} total=${m.total} remaining=${m.remaining}` +
        ` percent=${m.percent === null ? "n/a" : m.percent.toFixed(1)} unit=${m.unit}${reset}`
    );
  }
}

await closeBrowser();
console.log(`\n${failures === 0 ? "OK" : "FAILED"} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

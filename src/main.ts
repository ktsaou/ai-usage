import { loadConfig } from "./config.js";
import { DB } from "./db.js";
import { Scheduler } from "./scheduler.js";
import { startServer } from "./server.js";
import { closeBrowser } from "./providers/browser.js";

const config = loadConfig();
const db = new DB(config.dbPath);
const scheduler = new Scheduler(config, db);

scheduler.start();
const { httpServer, closeMcp } = await startServer(config, db, scheduler);

// Nothing in the product reads samples older than 30 days, and a poll every
// minute adds ~18k rows a day, so without this the database grows forever.
const retentionDays = config.retentionDays ?? 90;
function prune() {
  const removed = db.prune(retentionDays);
  if (removed) console.log(`[db] pruned ${removed} samples older than ${retentionDays} days`);
}
prune();
const pruneTimer = setInterval(prune, 24 * 3600 * 1000);

async function shutdown() {
  clearInterval(pruneTimer);
  scheduler.stop();
  await closeMcp().catch(() => {});
  httpServer.close();
  // Awaited: this writes the browser session cookies that a restart needs.
  await closeBrowser().catch(() => {});
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  console.log("\n[main] shutting down...");
  void shutdown();
});

process.on("SIGTERM", () => void shutdown());

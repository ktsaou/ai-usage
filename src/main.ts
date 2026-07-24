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

async function shutdown() {
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

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderResult, UsageMetric } from "./types.js";

export class DB {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS measurements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        used REAL,
        total REAL,
        remaining REAL,
        percent REAL,
        unit TEXT NOT NULL DEFAULT '',
        window TEXT,
        resets_at INTEGER,
        fetched_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_measurements_provider_time
        ON measurements(provider_id, fetched_at DESC)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_measurements_time
        ON measurements(fetched_at DESC)
    `);
  }

  store(result: ProviderResult): void {
    const stmt = this.db.prepare(`
      INSERT INTO measurements
        (provider_id, provider_type, provider_name, metric_name, used, total, remaining, percent, unit, window, resets_at, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const m of result.metrics) {
      stmt.run(
        result.providerId,
        result.providerType,
        result.name,
        m.name,
        m.used,
        m.total,
        m.remaining,
        m.percent,
        m.unit,
        m.window,
        m.resetsAt,
        result.fetchedAt
      );
    }
  }

  history(providerId: string, days: number): any[] {
    const since = Date.now() - days * 24 * 3600 * 1000;
    const stmt = this.db.prepare(
      "SELECT * FROM measurements WHERE provider_id = ? AND fetched_at >= ? ORDER BY fetched_at ASC"
    );
    return stmt.all(providerId, since);
  }

  latest(providerId: string): any[] {
    const stmt = this.db.prepare(
      "SELECT * FROM measurements WHERE provider_id = ? ORDER BY fetched_at DESC LIMIT 20"
    );
    return stmt.all(providerId);
  }

  allLatest(): any[] {
    const stmt = this.db.prepare(`
      SELECT m.* FROM measurements m
      INNER JOIN (
        SELECT provider_id, metric_name, MAX(fetched_at) as max_ts
        FROM measurements GROUP BY provider_id, metric_name
      ) latest
      ON m.provider_id = latest.provider_id
        AND m.metric_name = latest.metric_name
        AND m.fetched_at = latest.max_ts
      ORDER BY m.provider_id, m.metric_name
    `);
    return stmt.all();
  }

  close(): void {
    this.db.close();
  }
}

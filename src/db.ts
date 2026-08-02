import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderResult, UsageMetric } from "./types.js";

/** Which stored column carries the value a chart or a runway is drawn from. */
export type ValueColumn = "percent" | "used" | "total";

export interface Sample {
  t: number;
  v: number;
}

export interface PaygAnchors {
  last: Sample;
  base: Sample;
  /** True when history does not reach back a full window, so `base` is its start. */
  sinceFirst: boolean;
}

// Interpolated into SQL, so it may only ever be one of these.
const VALUE_COLUMNS: readonly ValueColumn[] = ["percent", "used", "total"];

function column(name: ValueColumn): ValueColumn {
  if (!VALUE_COLUMNS.includes(name)) throw new Error(`invalid value column: ${name}`);
  return name;
}

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

  /**
   * The last `limit` samples of one metric, oldest first — what a sparkline
   * draws. The dashboard used to derive this by downloading the whole history.
   */
  sparkline(providerId: string, metricName: string, value: ValueColumn, limit: number): number[] {
    const col = column(value);
    const rows = this.db
      .prepare(
        `SELECT ${col} AS v FROM measurements
          WHERE provider_id = ? AND metric_name = ? AND ${col} IS NOT NULL
          ORDER BY fetched_at DESC LIMIT ?`
      )
      .all(providerId, metricName, limit) as Array<{ v: number }>;
    return rows.map((r) => r.v).reverse();
  }

  /**
   * The two samples a burn rate is measured between: the newest one, and the
   * newest at or before `windowMs` earlier. When history is shorter than the
   * window the oldest sample stands in, which the caller labels differently.
   */
  paygAnchors(
    providerId: string,
    metricName: string,
    value: ValueColumn,
    windowMs: number
  ): PaygAnchors | null {
    const col = column(value);
    const where = `WHERE provider_id = ? AND metric_name = ? AND ${col} IS NOT NULL`;
    const pick = (order: "ASC" | "DESC", cutoff?: number) =>
      this.db
        .prepare(
          `SELECT fetched_at AS t, ${col} AS v FROM measurements
            ${where} ${cutoff === undefined ? "" : "AND fetched_at <= ?"}
            ORDER BY fetched_at ${order} LIMIT 1`
        )
        .get(...(cutoff === undefined ? [providerId, metricName] : [providerId, metricName, cutoff])) as
        | Sample
        | undefined;

    const last = pick("DESC");
    if (!last) return null;
    const before = pick("DESC", last.t - windowMs);
    return { last, base: before ?? pick("ASC") ?? last, sinceFirst: !before };
  }

  /**
   * Drops samples older than `days`. No VACUUM: SQLite reuses the freed pages
   * for later inserts, so the file settles at a steady size, while rewriting it
   * daily would cost a full copy to reclaim space that is about to be refilled.
   */
  prune(days: number): number {
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const info = this.db.prepare("DELETE FROM measurements WHERE fetched_at < ?").run(cutoff);
    return Number(info.changes);
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

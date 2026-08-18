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

/** The two samples a quota's burn rate is measured between. */
export interface MetricAnchors {
  last: Sample;
  base: Sample;
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
   * The two samples a quota's burn rate is measured between: the newest one, and
   * the newest at or before `lookbackMs` earlier **within the same window
   * instance**, falling back to that instance's first sample when history does
   * not reach back that far.
   *
   * The window constraint is the whole point: `used` drops to zero at a reset,
   * so a pair spanning one reads as a large negative rate — or, worse, as a
   * plausible small one. Rolling windows carry no reset instant (`resets_at IS
   * NULL`) and are therefore one continuous instance, which is what they are.
   */
  metricAnchors(providerId: string, metricName: string, lookbackMs: number): MetricAnchors | null {
    const last = this.db
      .prepare(
        `SELECT fetched_at AS t, percent AS v, resets_at AS w FROM measurements
          WHERE provider_id = ? AND metric_name = ? AND percent IS NOT NULL
          ORDER BY fetched_at DESC LIMIT 1`
      )
      .get(providerId, metricName) as (Sample & { w: number | null }) | undefined;
    if (!last) return null;

    // `IS` rather than `=` so the NULL of a rolling window matches itself.
    const inWindow = (extra: string, ...args: number[]) =>
      this.db
        .prepare(
          `SELECT fetched_at AS t, percent AS v FROM measurements
            WHERE provider_id = ? AND metric_name = ? AND percent IS NOT NULL
              AND resets_at IS ? ${extra}`
        )
        .get(providerId, metricName, last.w, ...args) as Sample | undefined;

    const base =
      inWindow("AND fetched_at <= ? ORDER BY fetched_at DESC LIMIT 1", last.t - lookbackMs) ??
      inWindow("ORDER BY fetched_at ASC LIMIT 1");
    if (!base || base.t >= last.t) return null;
    return { last: { t: last.t, v: last.v }, base };
  }

  /**
   * The most this metric was consumed in any **sixty minutes** since `since` —
   * how hard the quota gets hit when it is being used at all, which a rate
   * measured over the last hour cannot show while nobody is working.
   *
   * The window slides. Bucketing by clock hour instead is one cheap aggregate,
   * but it splits a burst that straddles a boundary into two halves: a real
   * 40%/h burst from 10:45 to 11:15 was reported as 20%/h, understating the
   * figure the elevated level is decided by, by half.
   *
   * `PARTITION BY resets_at` keeps a window from spanning a reset, where the
   * drop to zero would otherwise read as the trough of a huge rise. Measuring
   * from the lowest point in the trailing hour rather than from the sample an
   * hour ago also does the right thing for a rolling window, whose used figure
   * falls as old usage ages out.
   */
  peakHourlyRise(providerId: string, metricName: string, since: number): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(d) AS peak FROM (
           SELECT percent - MIN(percent) OVER (
                    PARTITION BY resets_at ORDER BY fetched_at
                    RANGE BETWEEN 3600000 PRECEDING AND CURRENT ROW
                  ) AS d
             FROM measurements
            WHERE provider_id = ? AND metric_name = ? AND percent IS NOT NULL AND fetched_at >= ?)`
      )
      .get(providerId, metricName, since) as { peak: number | null } | undefined;
    return row?.peak ?? null;
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

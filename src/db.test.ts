import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB } from "./db.js";
import type { ProviderResult } from "./types.js";

const H = 3600000;
const NOW = 1_760_000_000_000;

function withDb(fn: (db: DB) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ai-usage-test-"));
  const db = new DB(join(dir, "test.db"));
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One sample of one quota, as the scheduler would store it. */
function sample(db: DB, at: number, percent: number, resetsAt: number | null): void {
  const result: ProviderResult = {
    providerId: "p",
    providerType: "p",
    name: "P",
    plan: null,
    metrics: [
      {
        name: "5h_quota",
        used: percent,
        total: 100,
        remaining: 100 - percent,
        percent,
        unit: "%",
        window: "5h",
        resetsAt,
      },
    ],
    fetchedAt: at,
    error: null,
  };
  db.store(result);
}

test("anchors never span a reset — the drop to zero would read as a rate", () => {
  withDb((db) => {
    const oldWindow = NOW - 2 * H;
    // A window that filled up, then reset an hour ago and started again.
    sample(db, NOW - 4 * H, 10, oldWindow);
    sample(db, NOW - 3 * H, 80, oldWindow);
    sample(db, NOW - 1 * H, 2, NOW + 4 * H);
    sample(db, NOW, 6, NOW + 4 * H);

    // Asking for three hours back must not reach into the previous window.
    const a = db.metricAnchors("p", "5h_quota", 3 * H)!;
    assert.equal(a.last.v, 6);
    assert.equal(a.base.v, 2, "must fall back to the current window's first sample");
    assert.equal(a.base.t, NOW - 1 * H);
  });
});

test("anchors take the newest sample at or before the lookback", () => {
  withDb((db) => {
    const reset = NOW + 4 * H;
    sample(db, NOW - 3 * H, 5, reset);
    sample(db, NOW - 2 * H, 15, reset);
    sample(db, NOW - 1 * H, 25, reset);
    sample(db, NOW, 40, reset);

    const a = db.metricAnchors("p", "5h_quota", 1 * H)!;
    assert.equal(a.base.v, 25);
    assert.equal(a.last.v, 40);
  });
});

test("a rolling window is one continuous instance", () => {
  withDb((db) => {
    sample(db, NOW - 3 * H, 20, null);
    sample(db, NOW - 1 * H, 35, null);
    sample(db, NOW, 30, null); // rolling quotas fall again as usage ages out

    // Nothing splits the history, so the lookback reaches straight past the
    // intermediate sample to the one before it.
    const a = db.metricAnchors("p", "5h_quota", 2 * H)!;
    assert.equal(a.base.v, 20);
    assert.equal(a.base.t, NOW - 3 * H);
    assert.equal(a.last.v, 30);
  });
});

test("the peak hour is the largest rise inside one hour, ignoring the reset drop", () => {
  withDb((db) => {
    const first = NOW + 4 * H;
    const hour = (n: number) => NOW - n * H;
    sample(db, hour(5), 0, first);
    sample(db, hour(5) + 60000, 4, first); // +4 in that hour
    sample(db, hour(4), 10, first);
    sample(db, hour(4) + 60000, 40, first); // +30 in that hour
    sample(db, hour(3), 90, first);
    sample(db, hour(3) + 60000, 1, NOW + 9 * H); // reset: 90 -> 1, not a rise

    assert.equal(db.peakHourlyRise("p", "5h_quota", NOW - 24 * H), 30);
  });
});

test("the peak hour ignores samples older than the requested start", () => {
  withDb((db) => {
    const reset = NOW + 4 * H;
    sample(db, NOW - 30 * H, 0, reset);
    sample(db, NOW - 30 * H + 60000, 50, reset); // a huge hour, but out of range
    sample(db, NOW - 1 * H, 60, reset);
    sample(db, NOW - 1 * H + 60000, 63, reset);

    assert.equal(db.peakHourlyRise("p", "5h_quota", NOW - 24 * H), 3);
  });
});

test("no history yields no anchors and no peak", () => {
  withDb((db) => {
    assert.equal(db.metricAnchors("p", "5h_quota", H), null);
    assert.equal(db.peakHourlyRise("p", "5h_quota", NOW - 24 * H), null);
  });
});

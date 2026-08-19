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

test("the peak is the worst sixty minutes, even across an hour boundary", () => {
  withDb((db) => {
    const reset = NOW + 4 * H;
    // 40% consumed between :45 and :15 of the next hour. Bucketing by clock hour
    // would call this two 20% halves; it is one 40% hour.
    const onTheHour = NOW - (NOW % H) - 2 * H;
    for (let i = 0; i <= 90; i++) {
      const consumed = i < 45 ? 0 : i < 75 ? ((i - 45) * 40) / 30 : 40;
      sample(db, onTheHour + i * 60000, consumed, reset);
    }
    assert.equal(Math.round(db.peakHourlyRise("p", "5h_quota", NOW - 24 * H)!), 40);
  });
});

test("the peak never counts the drop at a reset as consumption", () => {
  withDb((db) => {
    const first = NOW + 1 * H;
    sample(db, NOW - 3 * H, 10, first);
    sample(db, NOW - 2 * H, 95, first); // 85 in an hour, the real peak
    sample(db, NOW - 1 * H, 2, NOW + 6 * H); // reset: 95 -> 2 is not a rise
    sample(db, NOW - 30 * 60000, 5, NOW + 6 * H);
    assert.equal(Math.round(db.peakHourlyRise("p", "5h_quota", NOW - 24 * H)!), 85);
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
    assert.equal(db.peakHourlyRise("p", "5h_quota", NOW - 40 * H), 50);
  });
});

test("no history yields no anchors and no peak", () => {
  withDb((db) => {
    assert.equal(db.metricAnchors("p", "5h_quota", H), null);
    assert.equal(db.peakHourlyRise("p", "5h_quota", NOW - 24 * H), null);
  });
});

test("the chart series is oldest-first and no longer than asked", () => {
  withDb((db) => {
    const reset = NOW + 4 * H;
    for (let i = 0; i < 200; i++) sample(db, NOW - (200 - i) * 60000, i, reset);

    const pts = db.sparkline("p", "5h_quota", "percent", 121);
    assert.equal(pts.length, 121, "the card asks for 121 samples: 120 one-minute intervals");
    assert.deepEqual(pts, [...pts].sort((a, b) => a - b), "oldest first, so the newest minute is the right-hand edge");
    assert.equal(pts.at(-1), 199, "the last point is the newest sample");
  });
});

test("the chart series keeps the drop at a reset, for the consumer to clamp", () => {
  withDb((db) => {
    // The dashboard derives per-minute consumption as the difference between
    // adjacent points and clamps negatives away, because a reset is not usage.
    // That only works if the series still carries the drop, unsmoothed.
    sample(db, NOW - 3 * 60000, 90, NOW - 2 * 60000);
    sample(db, NOW - 2 * 60000, 2, NOW + 5 * H);
    sample(db, NOW - 1 * 60000, 5, NOW + 5 * H);

    const pts = db.sparkline("p", "5h_quota", "percent", 121);
    assert.deepEqual(pts, [90, 2, 5]);
    const used = pts.slice(1).map((v, i) => Math.max(0, v - pts[i]));
    assert.deepEqual(used, [0, 3], "the reset minute consumed nothing; the next consumed 3");
  });
});

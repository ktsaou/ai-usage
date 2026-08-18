import { test } from "node:test";
import assert from "node:assert/strict";
import { countdown } from "./mcp-server.js";

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

test("durations read as durations, never as decimals", () => {
  assert.equal(countdown(45 * S), "45s");
  assert.equal(countdown(90 * S), "1m 30s");
  assert.equal(countdown(H), "1h 0m");
  assert.equal(countdown(1.8 * H), "1h 48m"); // was "1.8h"
  assert.equal(countdown(26 * H), "1d 2h");
  assert.equal(countdown(8.6 * D), "8d 14h"); // was "8.6d"
});

test("two units at most — the third never changed a decision", () => {
  assert.equal(countdown(3 * D + 4 * H + 18 * M + 18 * S), "3d 4h");
  assert.equal(countdown(2 * H + 55 * M + 36 * S), "2h 55m");
});

test("nothing left to count down is `now`, not a negative duration", () => {
  assert.equal(countdown(0), "now");
  assert.equal(countdown(-5 * H), "now");
  assert.equal(countdown(NaN), "now");
  assert.equal(countdown(Infinity), "now");
});

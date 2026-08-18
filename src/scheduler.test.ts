import { test } from "node:test";
import assert from "node:assert/strict";
import { providerState } from "./scheduler.js";

test("one failed poll is not an outage", () => {
  // A one-second network fault took three providers to `down` for a minute,
  // which reads as "these subscriptions are gone".
  assert.equal(providerState(0, true), "ok");
  assert.equal(providerState(1, true), "stale");
});

test("two in a row is", () => {
  assert.equal(providerState(2, true), "down");
  assert.equal(providerState(7, true), "down");
});

test("with nothing cached there is nothing to be stale about", () => {
  // A provider that has never answered cannot be served from memory, so the
  // first failure is already the whole truth about it.
  assert.equal(providerState(1, false), "down");
  assert.equal(providerState(2, false), "down");
});

test("a success clears it", () => {
  assert.equal(providerState(0, true), "ok");
  assert.equal(providerState(0, false), "ok");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeLanding } from "./providers/alibaba.js";

test("a landing is reported as origin and path, never the query or fragment", () => {
  // Sign-in redirects carry auth codes in the query; the fragment is the console's router state.
  const out = describeLanding(
    "https://account.example.com/login/third_party_bind_login.htm?code=SECRET123&state=abc#/efm/plan",
    "Sign in"
  );
  assert.equal(out, 'https://account.example.com/login/third_party_bind_login.htm "Sign in"');
  assert.doesNotMatch(out, /SECRET123|state=|#/);
});

test("a title is whitespace-collapsed and capped, and an empty one is omitted", () => {
  const long = "x".repeat(200);
  assert.equal(describeLanding("https://c.example.com/p", `  New\n\n  Console  ${long}`).length, "https://c.example.com/p".length + 3 + 80);
  assert.equal(describeLanding("https://c.example.com/p", "   "), "https://c.example.com/p");
});

test("an unparseable url does not throw", () => {
  assert.equal(describeLanding("chrome-error://chromewebdata/", ""), "chrome-error://chromewebdata/");
  assert.equal(describeLanding("", "Error"), '(unparseable url) "Error"');
});

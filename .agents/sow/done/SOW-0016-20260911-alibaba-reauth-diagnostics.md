# SOW-0016 - Explain why Alibaba self re-authentication fails

## Status

Status: completed

Sub-state: shipped; awaiting the next natural session expiry for live evidence.

## Requirements

### Purpose

When the daemon's own sign-in to the Alibaba console does not restore the session, the journal must say what it found — where the tab landed and what the page was — so the operator can tell an expired identity session from a challenge page or a changed login flow without reproducing it by hand.

### User Request

Follow-up of the 2026-09-09 outage: Alibaba's console session expired and 314 consecutive self re-authentication attempts over two days failed, while the identity-provider cookies in the profile were alive and being touched by every attempt. The journal carried only `console session expired — signing in again` and the generic operator error, so the cause is unknown.

### Assistant Understanding

Facts:

- Self re-authentication navigates to the console's third-party sign-in link and expects to land back on the console (`src/providers/alibaba.ts`; see the spec's session model). On failure it reports `session expired and automatic sign-in did not restore it`.
- Nothing records the landing origin, the page title, or whether the sign-in page showed a challenge. The profile's identity-provider cookies (names, domains and expiry only) showed a live session throughout the outage.

Inferences:

- The flow reached the identity provider and returned without a console session, which fits a consent or challenge page, but nothing observed proves which.

Unknowns:

- What the tab showed after the failed sign-in. This SOW exists to make that observable.

### Acceptance Criteria

- A failed self re-authentication logs the final origin and path class of the tab and a short, sanitized page title, never query strings or cookies.
- A unit test covers the log line's redaction.
- The spec's session model and `CREDS.md` state what the operator will see.

## Analysis

Sources checked:

- Journal of the 2026-09-09 outage; the profile cookie store (names, domains, expiry only); `src/providers/alibaba.ts`.

Current state:

- Not started.

Risks:

- Logging a landing URL can leak an auth code: log origin and path only, never the query.

## Pre-Implementation Gate

Status: ready

Problem / root-cause model:

- `relogin()` in `src/providers/alibaba.ts` navigates to the sign-in link, waits 3 s, and the caller judges the session by one gateway call. Nothing observes the page, so a failed sign-in leaves no evidence; and a landing page that is slow to establish the session is indistinguishable from a dead identity session.

Evidence reviewed:

- Journal of the 2026-09-09 outage (314 attempts, one identical line each); the profile's identity-provider cookies were alive throughout (names, domains, expiry only). The operator's manual sign-in on 2026-09-11 succeeded at once, and the user reports a new console UI with a splash — consistent with a changed landing, unproven.

Affected contracts and surfaces:

- `src/providers/alibaba.ts` (`relogin()`, `callGateway()`), new `src/alibaba.test.ts`, the spec's session model, `CREDS.md`, `AGENTS.md` debugging rules.

Existing patterns to reuse:

- `src/login.ts` prints only the host of a tab because sign-in redirects carry auth codes; the same rule shapes `describeLanding()`.

Risk and blast radius:

- On a failed sign-in only: two extra log lines and one extra gateway call after a 10 s wait, at most once per 10-minute cooldown. The successful path is unchanged.

Sensitive data handling plan:

- The landing line carries origin, path and a capped title; query strings and fragments are dropped. Unit-tested.

Implementation plan:

1. `describeLanding(url, title)` exported and tested; `relogin()` resolves to the landing (or null on cooldown).
2. `callGateway()`: after a sign-in that did not take, log the landing, wait 10 s, judge once more, log the outcome.
3. Spec, `CREDS.md`, `AGENTS.md`.

Validation plan:

- Unit tests for the redaction; `tsc`; deploy; polls unchanged; the next natural expiry (about 48 h after the 2026-09-11 sign-in) provides the live line.

Artifact impact plan:

- AGENTS.md: debugging rule added.
- Runtime project skills: none exist.
- Specs: session model updated.
- End-user/operator docs: `CREDS.md` updated.
- End-user/operator skills: none exist.
- SOW lifecycle: completes in one commit.

Open-source reference evidence:

- None relevant: the change is journal evidence around an existing local mechanism.

Open decisions:

- 3. Implement now (A) versus wait for the next expiry (B) — **A**. Decided.

## Implications And Decisions

3. A: logging only; the next expiry becomes evidence instead of a repeat outage.

## Plan

As the implementation plan.

## Execution Log

### 2026-09-11

- Implemented, tested, deployed.

## Validation

Acceptance criteria evidence:

- `describeLanding()` drops query and fragment, caps the title, survives an opaque-origin error page (`src/alibaba.test.ts`, 3 tests). `callGateway()` logs the landing and the outcome of the 10 s retry only after a sign-in that did not take.
- Spec session model, `CREDS.md` and `AGENTS.md` describe the journal lines.

Tests or equivalent validation:

- `npx tsc --noEmit` clean; `npm test` 69 passed.

Real-use evidence:

- Deployed; both Alibaba providers keep polling `ok` through the restart. The failure path cannot be triggered on demand without killing the live session (and the workstation holds a copy of it, so it cannot be exercised there either); the next natural expiry is the live test, and this SOW's outcome is conditional on it — reopen under Regressions if the line does not appear or does not explain the failure.

Reviewer findings:

- Self-review: the landing is captured inside `relogin()` before `getPage()` can re-navigate the tab; the retry happens only when a sign-in actually ran this call (`landing !== null`), so coalesced and cooled-down callers do not pay it.

Same-failure scan:

- Other self-healing paths that report failure without evidence: MiMo's token re-mint (`src/providers/mimo.ts`) logs its error text from the response; not changed, the provider is parked.

Sensitive data gate:

- No values, cookies, identifiers or host names in the artifacts; the log line format is designed to exclude auth codes.

Artifact maintenance gate:

- AGENTS.md: updated. Runtime project skills: none exist. Specs: updated. End-user/operator docs: `CREDS.md` updated. End-user/operator skills: none exist. SOW lifecycle: completed in the same commit.

Specs update:

- Session model paragraph.

Project skills update:

- None exist.

End-user/operator docs update:

- `CREDS.md` "when a session expires".

End-user/operator skills update:

- None exist.

Lessons:

- A self-healing path that reports only "it did not work" costs an outage per unknown cause; the evidence has to be captured at the moment of failure, because the state is gone by the time anyone looks.

Follow-up mapping:

- The 2026-09-13 expiry outcome: to be read from the journal; not a tracked item.

## Outcome

A failed self sign-in now records where it landed and whether a longer settle fixed it. Conditional on the next expiry confirming the line is informative.

## Lessons Extracted

See Validation → Lessons.

## Followup

None.

## Regression Log

None yet.

Append regression entries here only after this SOW was completed or closed and later testing or use found broken behavior. Use a dated `## Regression - YYYY-MM-DD` heading at the end of the file. Never prepend regression content above the original SOW narrative.

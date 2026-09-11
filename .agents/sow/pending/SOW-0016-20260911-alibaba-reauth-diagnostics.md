# SOW-0016 - Explain why Alibaba self re-authentication fails

## Status

Status: open

Sub-state: not started.

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

Status: blocked

Problem / root-cause model:

- Pending design; see Unknowns.

Evidence reviewed:

- Pending.

Affected contracts and surfaces:

- `src/providers/alibaba.ts`, its tests, the spec's session model, `CREDS.md`.

Existing patterns to reuse:

- The login tool prints only `new URL(t.url()).host` because sign-in redirects carry auth codes (`src/login.ts`).

Risk and blast radius:

- Logging only; no behaviour change.

Sensitive data handling plan:

- Origin and path only, titles truncated; no query strings, cookies or identifiers.

Implementation plan:

1. Pending.

Validation plan:

- Reproduce with a dead session against a stub sign-in page that lands on a challenge-like document; assert the log line.

Artifact impact plan:

- AGENTS.md: the browser-session debugging rules gain the new evidence source.
- Runtime project skills: none exist.
- Specs: session model.
- End-user/operator docs: `CREDS.md` "when a session expires".
- End-user/operator skills: none exist.
- SOW lifecycle: standalone.

Open-source reference evidence:

- None yet.

Open decisions:

- None yet.

## Implications And Decisions

Pending.

## Plan

Pending.

## Execution Log

### 2026-09-11

- Created after the operator re-login restored the session.

## Validation

Pending.

## Outcome

Pending.

## Lessons Extracted

Pending.

## Followup

None yet.

## Regression Log

None yet.

Append regression entries here only after this SOW was completed or closed and later testing or use found broken behavior. Use a dated `## Regression - YYYY-MM-DD` heading at the end of the file. Never prepend regression content above the original SOW narrative.

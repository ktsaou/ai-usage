# SOW-0003 - Console session lifetime: is the browser-session window absolute or sliding?

## Status

Status: in-progress

Sub-state: implemented and deployed. The answer needs a full session cycle to
arrive — the current session was created 2026-07-27 ~00:35 UTC, so the verdict
is due after 2026-07-29 ~00:35 UTC (48h). Nothing else in this SOW is pending.

## Requirements

### Purpose

Cut the operator cost of the browser-session providers. One console currently
forces the user to sign in again every two days; the daemon should keep its
session alive on its own if the site allows it.

### User Request

"alibaba tokens expired again" — then, after the analysis and options were
presented, the user chose: (1) re-login now, and (2) add the periodic revisit
experiment.

### Assistant Understanding

Facts:

- The console session died 2026-07-26 21:12 UTC. The last successful poll was
  21:11:03; the first failure 21:12:05.
- The session was created 2026-07-24 ~21:11 UTC. Recoverable because the site
  set a batch of 30-day cookies at login whose expiry stamps read
  `2026-08-23 21:11`. Login to death is therefore **48h to the minute**.
- It is not an idle timeout: the daemon polled every 60s throughout, with no gap.
- It is not caused by restarts: the service last started 18:09, three hours
  before the session died. Two earlier same-day restarts were survived.
- The profile holds **no persistent login cookie** for that console — only
  analytics and preference cookies. The whole login lives in session cookies.
- The other browser provider keeps *persistent* credentials (one-month expiry)
  and re-mints its short-lived token on each visit, which is why it has never
  needed the user again.
- The tabs are navigated once and then reused, so in those 48h the site never
  saw a page visit — only background XHRs.

Inferences:

- A session that renews on a real page visit and a session with an absolute
  lifetime are indistinguishable from the evidence gathered so far, because
  nothing ever revisited the console during the session's life.

Unknowns:

- Which of the two it is. Only a full cycle with periodic revisits can answer
  it; no amount of further code reading can.

### Acceptance Criteria

- The daemon revisits each browser-session console periodically, without
  disturbing in-flight polls and without turning ordinary polls into page loads.
  Verified by test.
- After one full cycle, the SOW records whether the session outlived 48h, and
  the spec records the real session-lifetime semantics.

## Analysis

Sources checked:

- Daemon journal on the host: last success / first failure / restart times.
- The profile's cookie store: persistent cookie names, domains and expiry only.
- `src/providers/browser.ts` tab lifecycle; `src/providers/alibaba.ts` and
  `src/providers/mimo.ts` poll paths.
- SOW-0001 session model and its recorded known limitation.

Current state:

- Sessions are restored at launch and saved every 5 minutes and at shutdown.
- Tab reuse: navigate once, then same-origin XHRs (SOW-0001 decision 5).

Risks:

- A revisit that lands while a poll is mid-request would break that poll.
- Too-frequent revisits would undo the decision that polls stay XHR-only.

## Pre-Implementation Gate

Status: ready

Problem / root-cause model:

- The console's login is session-cookie-only and stops working exactly 48h after
  it was created. The daemon cannot mint a session — only a human sign-in can —
  so the only lever available is whether *using* the site the way a human does
  (visiting a page) extends the window. The daemon has never done that after
  its first load.

Evidence reviewed:

- Journal timings and cookie expiry stamps (above), gathered first-party.
- `src/providers/browser.ts` (tab reuse), SOW-0001 (session model, decision 5).

Affected contracts and surfaces:

- `src/providers/browser.ts` only. No provider, API, schema, dashboard, MCP or
  config change. New optional environment knob `AI_USAGE_TAB_REFRESH_MS`.

Existing patterns to reuse:

- The existing lazy re-navigation inside `getPage`, extended with an age check,
  rather than a background timer.

Risk and blast radius:

- Contained: one extra page load per browser provider per interval. If the
  revisit fails, the existing recovery re-navigates on the next poll.
- Doing it on a timer would race in-flight polls; doing it inside `getPage`
  cannot, because a provider's tab is only ever touched by its own poll.

Sensitive data handling plan:

- Cookie evidence recorded as names, domains and expiry only — never values.
- No host names, account identifiers or URLs carrying auth codes in artifacts.

Implementation plan:

1. Track when each tab was last navigated; revisit when older than the interval.
2. Cover it in the browser recovery test, using the environment knob so the
   behaviour is testable in seconds rather than hours.
3. Deploy, then re-check after a full cycle and record the verdict.

Validation plan:

- Test: revisit happens after the interval, does not happen before it, and
  reuses the same tab; healthy tabs are still not reloaded within the interval.
- Real use: all providers healthy after deploy; verdict after the 48h mark.

Artifact impact plan:

- AGENTS.md: session-model section gains the measured lifetime and the knob.
- Runtime project skills: none — the operator flow is unchanged.
- Specs: `provider-quota-semantics.md` gains the revisit rule and the measured
  session lifetime.
- End-user/operator docs: CREDS.md already documents login + sync, which does
  not change. Revisit if the experiment removes the re-login need.
- End-user/operator skills: none exist.
- SOW lifecycle: stays `in-progress` in `current/` until the cycle completes,
  because its central question is not yet answered.

Open-source reference evidence:

- None checked. The question is about one vendor's session behaviour, which no
  external repository can answer.

Open decisions:

- None. The user chose re-login plus the experiment.

## Implications And Decisions

1. **Re-login now (user decision).** Done: the user signed in and all three
   browser providers verified against the real quota APIs.
2. **Run the revisit experiment (user decision).** Chosen over accepting a
   2-day re-login cycle. Cost is one page load per provider per interval; the
   payoff, if the window slides, is that the re-login mostly disappears.
3. **Interval: 6 hours.** Comfortably inside the 48h window with many chances to
   renew, while adding 4 page loads per provider per day. Overridable with
   `AI_USAGE_TAB_REFRESH_MS` so the interval can be tuned without a code change.
4. **Lazy revisit inside the poll, not a background timer.** A timer would
   navigate a tab out from under an in-flight request; inside `getPage` the
   tab is only ever touched by its own provider's poll.

## Plan

1. Age-tracked tab revisit in `src/providers/browser.ts`.
2. Test coverage for the interval behaviour.
3. Deploy code and the fresh profile; verify all providers.
4. After the cycle, record the verdict and update the spec.

## Execution Log

### 2026-07-27

- Measured the session lifetime from journal timings and cookie expiry stamps:
  48h to the minute, not idle-related, not restart-related.
- `src/providers/browser.ts`: tabs now carry `navigatedAt`; `getPage`
  re-navigates when the tab is older than `TAB_REFRESH_MS` (6h default,
  `AI_USAGE_TAB_REFRESH_MS` override).
- Test extended with the interval cases; `npx tsc --noEmit` clean.
- User re-logged in; profile synced to the daemon host; all providers verified.

## Validation

Acceptance criteria evidence:

- Revisit behaviour: covered by test (below). **Session-lifetime verdict:
  pending the 48h mark — this is why the SOW is not completed.**

Tests or equivalent validation:

- `test-errorpage-recovery` with `AI_USAGE_TAB_REFRESH_MS=1000`: 14/14 checks
  pass, including "not revisited before the interval", "revisited after the
  interval", "revisit reuses the same tab", and the pre-existing "no
  re-navigation of a healthy tab".
- `npx tsc --noEmit` clean.

Real-use evidence:

- Login tool verified all three browser providers against the live quota APIs
  before the profile was shipped.
- Post-deploy: recorded below once the daemon has polled.

Reviewer findings:

- Self-review caught that the age check must short-circuit *before* the
  document probe, and that a failed revisit must leave `navigatedAt` unset so
  the next poll retries rather than waiting another interval.
- The test initially raced its own failed navigation (two `goto`s with no gap,
  which real 60s polls never produce); the test was given a settle delay rather
  than the production code a workaround.

Same-failure scan:

- No other code path reuses a browser tab or long-lived client without
  rebuilding it; the two providers that share the console each own their tab.

Sensitive data gate:

- Cookie evidence recorded as names, domains and expiry only. No values, host
  names, account identifiers or auth-carrying URLs in this SOW.

Artifact maintenance gate:

- AGENTS.md: updated (measured lifetime, revisit rule, knob).
- Runtime project skills: none — operator flow unchanged.
- Specs: `provider-quota-semantics.md` updated with the revisit rule and the
  measured lifetime.
- End-user/operator docs: CREDS.md unchanged — the login and sync commands are
  the same; revisit if the experiment removes the need to re-login.
- End-user/operator skills: none exist.
- SOW lifecycle: stays `in-progress` in `current/` pending the verdict.

Specs update:

- Done.

Project skills update:

- None needed; the change is one behaviour rule already recorded in AGENTS.md
  and the spec.

End-user/operator docs update:

- None needed yet, for the reason above.

End-user/operator skills update:

- None exist.

Lessons:

- Recorded at close.

Follow-up mapping:

- Open item, tracked here: read the verdict after 2026-07-29 ~00:35 UTC and
  either (a) record a sliding window, relax the re-login expectation in the
  docs and close, or (b) record an absolute 48h lifetime, decide whether to keep
  the revisit at all, and close.

## Outcome

Pending the session cycle.

## Lessons Extracted

Pending.

## Followup

None beyond the verdict above.

## Regression Log

None yet.

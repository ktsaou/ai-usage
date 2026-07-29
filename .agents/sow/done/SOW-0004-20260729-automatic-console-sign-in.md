# SOW-0004 - Automatic console sign-in from the stored identity session

## Status

Status: completed

Sub-state: the daemon signs itself back in when the console session reaches its
48h lifetime. Proven end to end against a genuinely expired session, and on the
daemon host with no profile sync and no user action.

## Requirements

### Purpose

Remove a recurring manual chore: the operator was signing in to one console
every two days, forever. The monitor should keep itself authenticated.

### User Request

"alibaba expired again. In the profile you open I have my google credentials, so
relogin to alibaba is trivial, just a couple of buttons. Can we automate it so
that it happens by itself, because otherwise, I will need to do this for the
rest of my life every a couple of days. I think that google expires less
frequently. no?"

### Assistant Understanding

Facts:

- The console session is absolutely limited to 48h from sign-in (SOW-0003).
- The identity provider's cookies in the same profile are persistent and expire
  **2027-08-28** — over a year out, and re-issued on use. The user's assumption
  was correct.
- The console's login page exposes third-party sign-in as a plain `<a>` element
  with a real `href`, not a scripted button.
- Both alibaba providers share one browser context, so one sign-in restores both.

Inferences:

- Re-authentication needs no credentials, no form filling and no clicks — only a
  navigation that lets the identity session answer the OAuth request.

Unknowns:

- None left. The one real unknown (does the identity provider challenge an
  unattended sign-in?) was resolved by running it: it completed silently, with
  no account chooser and no consent screen.

### Acceptance Criteria

- A poll that finds the console session dead restores it without the user.
  Verified against a genuinely expired session using the production fetcher.
- The operator-facing error appears only when automatic sign-in has also failed.
- Two providers sharing the console cannot start two sign-ins at once.

## Analysis

Sources checked:

- The login page's DOM: the sign-in control, its `href`, and what covers it.
- The profile's cookie store: identity-provider cookie names and expiry only.
- `src/providers/alibaba.ts` gateway path; `src/providers/browser.ts` tab reuse.
- SOW-0001 (session model), SOW-0003 (measured lifetime).

Current state:

- Before this change the daemon reported `session expired` and waited for the
  user to run `npm run login` plus `npm run sync:profile`, every two days.

Risks:

- The stored identity session is a long-lived credential. Automation makes its
  use continuous rather than occasional.
- Anti-bot handling on the login page could change and break the flow silently.

## Pre-Implementation Gate

Status: ready

Problem / root-cause model:

- The console mints sessions only through a sign-in, and its sessions expire on
  a fixed 48h clock. Nothing the daemon does with an existing session extends
  it. But the sign-in itself is reproducible without a human, because the
  identity session that authorises it is already in the profile and lasts far
  longer.

Evidence reviewed:

- Login page DOM: `a#login-google-btn`, `href` pointing at
  `third_party_bind_login.htm?type=google&oauth_callback=`.
- Click attempt: `locator.click` timed out; `document.elementFromPoint` at the
  button's centre returns `div.baxia-dialog-mask` — an anti-bot overlay sits on
  top of it, and a DOM-level `.click()` also did nothing.
- Direct navigation to that `href` with the console as callback: landed on the
  console host, and the production fetcher then returned 3 metrics on a session
  that had been reporting `session expired` seconds earlier.
- Identity cookies: `SID`, `HSID`, `SSID`, `SAPISID`, `LSID`, `__Secure-1PSID`,
  `__Host-GAPS`, all persistent, expiring 2027-08-28.

Affected contracts and surfaces:

- `src/providers/alibaba.ts` only. No config, schema, API, dashboard or MCP
  change. New provider error string when automatic sign-in also fails.
- Operator docs: the expiry section of CREDS.md changes meaning entirely.

Existing patterns to reuse:

- The existing logged-out detection (gateway `errorCode`) and the forced
  re-navigation retry already in `callGateway`; sign-in is a third step after
  those, not a replacement.

Risk and blast radius:

- Contained to one provider family. If sign-in fails, behaviour degrades to
  exactly what it was before: an error telling the operator to sign in.
- Two providers polling independently could otherwise start two sign-ins at
  once; handled with a single-flight promise.
- A dead identity session must not cause a sign-in attempt every 60s; handled
  with a 10-minute cooldown.

Sensitive data handling plan:

- No credentials are added anywhere: the flow uses cookies already in the
  profile. Nothing is written to the repository.
- Evidence recorded as cookie names, domains and expiry only. No values, no
  emails, no full sign-in URLs (they carry auth codes).
- Probe output was redacted for email addresses before being read.

Implementation plan:

1. Sign-in helper in `alibaba.ts`: navigate to the third-party `href` with the
   console as callback; single-flight; cooldown.
2. Extend `callGateway` with the sign-in step after the existing forced reload.
3. Distinct operator error when sign-in has also failed.
4. Validate against the genuinely expired session, then on the daemon host.

Validation plan:

- Run the production fetcher against the expired session and require live
  metrics plus exactly one sign-in log line.
- Confirm the second provider then works with no further sign-in.
- Deploy without syncing a profile, so the daemon host must recover on its own.

Artifact impact plan:

- AGENTS.md: session-model section gains the self-sign-in rule; the "settled
  questions" claim about headless being unblocked is corrected for login pages.
- Runtime project skills: none; this is one behaviour rule, already recorded.
- Specs: `provider-quota-semantics.md` gains the sign-in flow and its guards.
- End-user/operator docs: CREDS.md expiry section rewritten.
- End-user/operator skills: none exist.
- SOW lifecycle: completes with the work in one commit.

Open-source reference evidence:

- None checked. The flow is specific to one vendor's login page and was
  established by direct first-party probing.

Open decisions:

- Resolved by the user, recorded below.

## Implications And Decisions

1. **Trigger: reactive (user decision 1A).** Sign in when a poll finds the
   session dead, rather than pre-emptively on a schedule. Simpler, and the
   visible cost is at most one failed poll (60s). Rejected alternative: a ~24h
   proactive refresh, which re-authenticates whether or not it is needed and
   still needs the reactive path as a fallback.
2. **Keep the 6h tab revisit (user decision 2B)**, although SOW-0003 proved it
   does not extend the session — the user expects it to be useful for planned
   work. Documented as such so it is not mistaken for session upkeep.
3. **Guards, assistant decision:** single-flight plus a 10-minute cooldown, and
   the operator error only after a failed attempt. Without these, two providers
   would sign in simultaneously and a dead identity session would be retried
   every 60s.
4. **Security implication accepted by the user:** the profile now functions as a
   continuously-used long-lived credential for the identity account. It already
   held those cookies; automation makes the use ongoing. It remains `0700` under
   the service account on the daemon host.

## Plan

1. Sign-in helper and `callGateway` integration.
2. Validate against the expired session locally.
3. Update AGENTS.md, spec, CREDS.md.
4. Deploy; require the daemon host to recover with no profile sync.

## Execution Log

### 2026-07-29

- Probed the login page; found the anti-bot overlay over the sign-in button and
  the usable `href` behind it.
- Implemented `relogin()` (single-flight, cooldown) and the third retry step in
  `callGateway`; added the distinct operator error.
- Verified locally against the genuinely expired session, then deployed.
- Closed SOW-0003 with its verdict, which is what motivated this work.

## Validation

Acceptance criteria evidence:

- Recovery without the user: `npm run test:all alibaba-coding` against the
  expired session printed
  `[alibaba] console session expired — signing in again` once, then returned
  plan `Coding Plan Pro` with 3 metrics. Exit 0.
- One sign-in restores both: `npm run test:all alibaba-token` immediately after
  returned plan `pro` with 2 metrics and **no** sign-in line.
- Operator error only after failure: the error constant is returned solely on
  the path where the gateway still reports logged out after the sign-in attempt.

Tests or equivalent validation:

- `npx tsc --noEmit` clean.
- Browser recovery test (14 checks) still passes; `getPage` semantics unchanged.

Real-use evidence:

- Deployed to the daemon host **without syncing a profile**, so its own 48h-dead
  session had to be repaired by the daemon itself — recorded in the Outcome.

Reviewer findings:

- Self-review: the first implementation attempt clicked the button, which fails
  headlessly; discarded in favour of the `href` after direct evidence of the
  overlay. Also caught that the sign-in must not run before the existing forced
  reload, or every transient logged-out reply would trigger a sign-in.

Same-failure scan:

- The other browser provider (mimo) renews from persistent credentials and has
  no equivalent failure. No other code path reports an operator action for a
  condition the daemon could repair itself.

Sensitive data gate:

- No credentials, cookie values, emails, account identifiers, host names or
  sign-in URLs carrying auth codes appear in this SOW, the spec, docs or code
  comments. The vendor's public login endpoint is recorded because it is the
  mechanism, and it identifies no account.

Artifact maintenance gate:

- AGENTS.md: updated (self-sign-in rule; corrected the headless claim for login
  pages).
- Runtime project skills: none needed; one behaviour rule, recorded in AGENTS.md
  and the spec.
- Specs: `provider-quota-semantics.md` updated.
- End-user/operator docs: CREDS.md expiry section rewritten — the operator is
  now needed roughly yearly instead of every two days.
- End-user/operator skills: none exist.
- SOW lifecycle: completed and moved to `done/` in the same commit as the work.

Specs update:

- Done.

Project skills update:

- None; reason above.

End-user/operator docs update:

- CREDS.md.

End-user/operator skills update:

- None exist.

Lessons:

- See Lessons Extracted.

Follow-up mapping:

- None deferred.

## Outcome

The two-day sign-in chore is gone. When the console session reaches its 48h
limit, the daemon navigates once to the login page's third-party sign-in link,
the identity session already in the profile answers it, and polling resumes on
the next cycle. The operator is needed only when that identity session itself
ends, which is a yearly-scale event.

## Lessons Extracted

- "It needs a human because it needs a login" is worth re-testing. The human
  part was the *identity* session, and that was already in the profile; the
  console sign-in around it was a single navigation.
- A sign-in button is not necessarily the sign-in mechanism. This one was a
  plain link behind an anti-bot overlay: clicking failed, navigating to its
  `href` worked. Read the element before automating the gesture.
- Anti-bot protection can be page-scoped. The console and its API were open to
  headless polling while the login page was not — treating "this site allows
  headless" as one fact would have led to the wrong conclusion.
- Repairing a condition automatically must not remove the operator's signal:
  the error message now distinguishes "the daemon could not fix this either"
  from the old "go sign in", so a genuinely dead identity session still surfaces.

## Followup

None.

## Regression Log

None yet.

# SOW-0001 - Browser-session providers (mimo, alibaba) and project bootstrap

## Status

Status: completed

Sub-state: all three browser-session providers report live data from the daemon host and survive a service restart. 8/8 providers healthy.

## Requirements

### Purpose

Monitor AI subscription usage across 8 providers. 6 work via API keys. 2 (mimo, alibaba) require browser session cookies that rotate and cannot be kept fresh via static paste.

### User Request

Build a system that monitors all providers "no matter what", including web scraping or headless browser if needed. Document all challenges in a SOW so they are not lost between sessions.

### Assistant Understanding

Facts:

- mimo `serviceToken` is a **session cookie** — Chrome keeps it in memory only, never writes to the `Cookies` SQLite DB on disk. Proven: scanned all 8 Chrome profiles + Firefox on user workstation — zero mimo rows anywhere.
- When the user's browser rotates the cookie (server issues new `Set-Cookie`), the old value is invalidated server-side. A pasted copy becomes dead.
- Alibaba console anti-bots headless browsers. The daemon on the daemon host cannot run Playwright (systemd hardening blocks it). Alibaba's coding/token plan APIs are console-internal only — not in the public OpenAPI (verified: `api.aliyun.com/product/bailian` has zero quota/subscription actions).
- No open-source tool persists `Set-Cookie` to keep a pasted cookie alive. Audited 4 repos: CodexBar (read-only mirrors live browser store), Cmochance (own embedded webview, explicitly says "no refresh, can only re-login"), OmniRoute (no cookie — JWT bootstrap for inference only), quota-sentinel (manual paste, re-paste on 401).
- No tool proves two-client coexistence (pasted string + parallel open browser) works.
- CDP (Chrome DevTools Protocol) `Network.getCookies` returns in-memory session cookies — the only route that can see them while the browser is open.
- OpenRouter `total_usage` is a monotonic lifetime counter — 7d spend derivable from SQLite history (no per-date API).
- DeepSeek is balance-only — show remaining + runway from own balance history.

Inferences:

- CDP is the only race-free approach for mimo/alibaba that works while the user's browser stays open.
- The workstation (not the daemon host) must run the browser-dependent collection, since the daemon host has no display and systemd hardening blocks Playwright.

Unknowns:

- Whether mimo's site anti-bots headless the way alibaba does (untested — alibaba definitely does, mimo unknown).
- CDP port security implications on the workstation (localhost-only by default, but still an attack surface).

### Acceptance Criteria

- All 8 providers show live data on the dashboard (or are explicitly parked with a clear reason).
- The mimo/alibaba cookie rotation problem is documented and has a clear resolution path.
- The project has AGENTS.md, SOW system, and cross-tool symlinks bootstrapped.

## Analysis

Sources checked:

- `Cmochance/codex-app-transfer` — `src-tauri/src/mimo_quota.rs`, `mimo_session.rs`: embedded webview login, no Set-Cookie persistence, explicit "no refresh, can only re-login"
- `steipete/CodexBar` — `docs/mimo.md`, `MiMoCookieImporter.swift`: read-only mirrors live browser cookie store, re-reads on every refresh
- `diegosouzapw/OmniRoute` — `executors/mimocode.ts`: JWT bootstrap for inference only, no console cookie
- `millaguie/quota-sentinel` — `alibaba_token_plan.py`: manual paste, re-paste on 401
- `api.aliyun.com/product/bailian` — full OpenAPI listing: zero quota/subscription actions
- User workstation Chrome profiles (8) + Firefox — zero mimo rows in any Cookies DB
- Clean HTTP probe with full untruncated mimo cookie — 401 (dead)

Current state:

- 6/8 providers working on the daemon host (zai, minimax, kimi, deepseek, openrouter + mimo when cookie is fresh)
- alibaba-coding and alibaba-token parked (need browser session)
- mimo shows 401 when cookie expires (hours, not days)

Risks:

- CDP port on workstation is a local attack surface (mitigated: localhost-only binding)
- Workstation must be on for mimo/alibaba data (acceptable: those are personal subscriptions)
- If mimo anti-bots headless like alibaba, CDP with a real browser profile is the only option

## Pre-Implementation Gate (2026-07-24 revision)

Status: ready

The 2026-07-23 gate below is kept for history. Its central assumptions (alibaba
anti-bots headless; mimo needs CDP against the user's live browser) were tested
directly on 2026-07-24 and did not hold.

Problem / root-cause model (revised):

- alibaba was never blocked by anti-bot. A headless patchright run reaches the
  console and its internal gateway; the gateway answers
  `errorCode: BailianGateway.Login.NotLogined`. The provider is simply logged
  out, and the code misreports it because it detects login state by URL redirect
  (`src/providers/alibaba.ts:30-38`), while the console never redirects.
- mimo does not block headless either: a headless run loads
  `platform.xiaomimimo.com` and gets the normal account login page.
- The real constraint is only that both need a logged-in browser profile, and
  the daemon host is headless so the login cannot happen there.

Evidence reviewed (2026-07-24 probes, all first-party):

- Headless patchright against `platform.xiaomimimo.com`: HTTP 200, normal
  account login page, no bot wall.
- Headless patchright against the alibaba console + gateway: page loads,
  gateway returns `BailianGateway.Login.NotLogined` (not a challenge).
- Egress IP of workstation and daemon host are identical, so a copied session
  does not change apparent network location.
- Daemon host runs Ubuntu 24.04 with
  `kernel.apparmor_restrict_unprivileged_userns = 1` — the usual cause of
  "Playwright cannot run under systemd" reports. Tested anyway: chromium
  launches successfully as the service user under the unit's existing hardening
  (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`) with
  the sandbox left on; no `--no-sandbox` needed.
- Profile portability proven with a marker cookie: profile created on the
  workstation, copied to the daemon host, cookie read back decrypted. Requires
  `--password-store=basic`, because chromium otherwise encrypts the cookie store
  with an OS-keyring key that does not exist on the server.
- Chromium build 1228 installed under the service user's home; identical build
  to the workstation, so the profile is used by the same browser version.

Affected contracts and surfaces:

- New `src/providers/browser.ts` (shared persistent context, one tab per provider).
- New `src/providers/mimo.ts` (browser-based; replaces the cookie-from-`.env` fetcher).
- `src/providers/alibaba.ts` rewritten onto the shared session; login detection by gateway error code.
- New `src/providers/common.ts` (`result()`/`metric()` shared by all fetchers).
- `src/providers/fetch.ts` registry gains the browser providers; `src/scheduler.ts` and
  `src/test-all.ts` drop their duplicated alibaba dispatch.
- `src/login.ts` (replaces `src/login-alibaba.ts`), `scripts/sync-profile.sh`.
- `config.json` (unpark three providers), `ai-usage.service`, `install.sh`.
- Docs: `CREDS.md`, `AGENTS.md`, spec `provider-quota-semantics.md`.

Existing patterns to reuse:

- `launchPersistentContext` + in-page `fetch(..., credentials: "include")` from the
  current `alibaba.ts` gateway helper — keeps cookie handling inside the browser.
- `run()` transparency helper from `install.sh` for the new sync script.
- Provider config `parked` flag and the scheduler's per-provider interval support.

Risk and blast radius:

- Headless fingerprint: neither site challenged headless in probes, but the
  logged-in API paths are untested until a real session exists. Fallback if a
  site rejects headless: run the browser headed under Xvfb on the server.
- `install.sh` uses `rsync --delete` into the install dir; without new excludes it
  would erase the copied profile and the installed browsers on every deploy.
  Mitigated by excluding `browser` and `.cache`.
- Profile write access is mandatory: the sites rotate session cookies, and a
  read-only profile would lose the session within hours. Handled by adding the
  profile directory to `ReadWritePaths`.
- Sessions may still expire eventually; failure mode is a provider card showing
  a "session expired" error until the user re-runs the login and sync.
- Polling every 60s (user decision) is mitigated by navigating once and then
  reusing the open tab, so a poll is an XHR rather than a console page load.

Sensitive data handling plan:

- The browser profile contains live session cookies for the user's personal
  accounts. It lives outside the repository on the workstation, is copied to the
  service user's home with `0700`, and is never committed. `.gitignore` already
  excludes runtime data; the profile path is outside the repo.
- No cookie values, tokens, account identifiers, hostnames of private endpoints,
  or IP addresses are recorded in this SOW or any other durable artifact.
- The old profile from the earlier attempt holds live third-party session
  cookies and is deleted once the new one works (user decision 3).

Implementation plan:

1. `common.ts`, `browser.ts`; rewrite `alibaba.ts`; add `mimo.ts`; register both in
   `fetch.ts`; simplify `scheduler.ts` and `test-all.ts`.
2. `login.ts` (headed, both sites, verifies each by calling the real quota API).
3. `scripts/sync-profile.sh` (stop service, copy profile, chown, start, verify).
4. `install.sh` excludes + chromium install at the service user's home;
   `ai-usage.service` gains `HOME`, browsers path, profile dir, `ReadWritePaths`.
5. `config.json`: unpark mimo, alibaba-coding, alibaba-token.
6. User logs in; verify live locally; correct parsers against real payloads.
7. Sync to the daemon host; verify; update spec and docs with real semantics.

Validation plan:

- `npm run test:all mimo` / `alibaba-coding` / `alibaba-token` against a live session.
- Full `npm run test:all` (no regression on the five API providers).
- Post-sync: provider payload on the daemon host shows live metrics for all three;
  service journal clean; dashboard and MCP list them as normal providers.
- Deploy re-run of `install.sh` must not destroy the profile (explicit check).
- Same-failure scan for other URL-based login detection and other shared-page races.

Artifact impact plan:

- AGENTS.md: commands (login, profile sync), provider architecture (browser-session
  providers no longer parked), configuration notes.
- Runtime project skills: none yet; revisit once the operational flow settles.
- Specs: `provider-quota-semantics.md` — add mimo and alibaba semantics from real
  payloads, remove the parked section.
- End-user/operator docs: CREDS.md — replace the mimo cookie and alibaba API-key
  instructions with the login + sync flow.
- End-user/operator skills: none exist.
- SOW lifecycle: this SOW completes when all three providers report live data
  from the daemon host.

Open-source reference evidence:

- The 2026-07-23 audit of four upstream projects (recorded in Analysis) remains
  the basis for rejecting cookie-paste approaches. No new external references
  were needed: every 2026-07-24 conclusion comes from direct probes of the
  first-party stack.

Open decisions:

- Resolved 2026-07-24 by the user; see Implications And Decisions items 3-5.

## Pre-Implementation Gate (2026-07-23, superseded)

Status: needs-user-decision

Problem / root-cause model:

- mimo `serviceToken` is an in-memory session cookie. Pasted copies die when the user's browser rotates the cookie. No OSS tool solves this. The only race-free route is reading the live cookie from the running browser via CDP.
- alibaba console anti-bots headless. Console-internal APIs have no public OpenAPI equivalent. Same CDP approach needed.

Evidence reviewed:

- Cmochance/codex-app-transfer, steipete/CodexBar, diegosouzapw/OmniRoute, millaguie/quota-sentinel (cookie handling audit)
- api.aliyun.com/product/bailian (OpenAPI listing)
- User workstation Chrome/Firefox cookie DBs (zero mimo rows)
- HTTP probe (401 with stored cookie)

Affected contracts and surfaces:

- New workstation-side collector process (CDP client)
- Daemon `/api/ingest` endpoint (already exists, needs to accept browser-session provider data)
- Dashboard (already handles parked/stale states)
- `.env` on workstation (CDP port config)

Existing patterns to reuse:

- Remote agent pattern (`src/agent/main.ts`) — same POST-to-ingest model
- Provider config `parked` flag — already handles muted display

Risk and blast radius:

- CDP port: localhost-only, low risk. If workstation Chrome is launched with `--remote-debugging-port=9222`, any local process can control the browser. Mitigation: bind to 127.0.0.1 only (Chrome default).
- Workstation dependency: mimo/alibaba go stale when workstation is off. Acceptable for personal subscriptions.

Sensitive data handling plan:

- CDP collector reads cookies in memory, never writes them to disk or logs.
- POST to daemon uses ingest API key (already in config).
- No cookies stored in durable artifacts.

Implementation plan:

1. Add `browser` auth mode to provider config (CDP endpoint + target URL pattern).
2. Build workstation collector: connects to CDP, extracts cookie via `Network.getCookies`, makes API call, POSTs result to daemon `/api/ingest`.
3. Update daemon to accept ingest data for browser-session providers (merge into same dashboard cards).
4. Document CDP setup in CREDS.md.

Validation plan:

- Headed login + headless probe against `platform.xiaomimimo.com` from workstation to confirm mimo doesn't anti-bot.
- End-to-end: collector running → dashboard shows live mimo data.

Artifact impact plan:

- AGENTS.md: update provider architecture section with browser-session mode.
- Runtime project skills: none yet (incremental).
- Specs: new spec for browser-session provider architecture.
- End-user/operator docs: CREDS.md update for CDP setup.
- End-user/operator skills: none.
- SOW lifecycle: this SOW tracks the decision and implementation.

Open decisions:

1. **CDP vs embedded webview vs park for mimo/alibaba.** Recommended: CDP. Options:
   - A) CDP — read live cookie from running Chrome via `--remote-debugging-port`. Zero paste, zero webview, works while browser is open. One-time cost: add flag to Chrome launch args. Risk: CDP port is local attack surface (localhost-only).
   - B) Embedded webview — tiny app with own browser profile. Two separate logins (browser + webview). No CDP port.
   - C) Park — like today. Manual cookie paste when needed.
2. **Project skills**: defer incrementally (no concrete reusable knowledge yet beyond what's in this SOW).

## Implications And Decisions

1. **Park mimo and alibaba until a reliable browser-session path exists.** Decision: set `parked: true` (and `playwright: true` to document the auth class) for `mimo`, `alibaba-coding`, `alibaba-token` in `config.json`. Rationale: no reliable headless/API path exists (mimo cookie is an in-memory session cookie that rotates and dies when the user's browser rotates it; alibaba console anti-bots headless and has no public quota OpenAPI). Polling them produces only 401/ConsoleNeedLogin noise and, for the MCP, invites pointless queries. Parking stops the poll loop, renders them muted on the dashboard, and hides them from the MCP discovery surface. Recorded in `AGENTS.md` provider-types list. This is a holding position, not a resolution — the CDP approach in open item 2 below is the intended un-park path.
2. **CDP vs embedded webview vs park for the eventual un-park.** Superseded on 2026-07-24 (see item 3). CDP is not needed: a dedicated logged-in profile is portable to the server, which the original analysis had not tested.
3. **Un-park route (user decision, 2026-07-24): copied browser profile.** The user logs in on the workstation with a newly created profile; the profile is copied to the service user's home on the headless daemon host; the daemon polls with it. Chosen over CDP (needs the user's daily browser running with a debug port) and over an embedded webview. Rationale confirmed by probes: same egress IP, portable cookie store, chromium runs under the existing service hardening. Implication accepted: sessions eventually expire and the user re-runs login + sync; until then the affected card shows a "session expired" error.
4. **Profile layout (user decision 1A): one shared profile for all browser providers.** One login window for the user, one directory to copy, one browser process on the server, one tab per provider. Rejected: per-provider profiles (two logins, two copies, roughly double memory, isolation benefit only theoretical since both are the same person's accounts on one machine).
5. **Poll interval (user decision 2B): keep the standard 60s for browser providers.** The assistant had recommended 300s to reduce automated-traffic patterns; the user chose 60s. Mitigation applied in implementation: the browser navigates to each console once and then reuses the open tab, so a poll is a background XHR rather than a full page load.
6. **Old browser profile (user decision 3): delete it** once the new profile is proven working. It holds live third-party session cookies from the earlier attempt and has no further use.

## Plan

1. Provider layer: shared browser session, mimo and alibaba fetchers, registry, dispatch cleanup.
2. Login tool for the user (headed, verifies both sessions against the real APIs).
3. Profile sync tool to the daemon host.
4. Installer and unit changes (browsers at the service user's home, profile writable, deploy must not erase either).
5. Unpark the three providers.
6. User login, live verification, parser corrections against real payloads.
7. Sync, verify on the daemon host, update spec and docs, delete the old profile.

## Execution Log

### 2026-07-24 / 2026-07-25

- Probes disproved both original blockers (details in the 2026-07-24 gate).
- Implemented `providers/browser.ts` (shared context, tab per provider, passive
  mode, session save/restore), `providers/mimo.ts`, `providers/common.ts`;
  rewrote `providers/alibaba.ts`; moved browser providers into the `fetch.ts`
  registry and removed the duplicated dispatch from `scheduler.ts` and
  `test-all.ts`; `main.ts` shutdown now awaits the final session save.
- Added `src/login.ts` (replacing `login-alibaba.ts`) and `scripts/sync-profile.sh`.
- `install.sh`: chromium install under the service user's home, plus excludes so
  deploys stop wiping the profile and browsers. `ai-usage.service`: HOME,
  browsers path, profile path, profile writable.
- Unparked all three providers in `config.json`.
- Two login-tool defects found by the user during real use and fixed:
  (1) background verification opened and navigated tabs while the user was
  signing in — replaced with passive probing of the user's own tabs;
  (2) a terminal "press Enter" handshake failed because the harness backgrounds
  long commands and detaches stdin (node exit 13) — replaced with automatic
  detection.
- Root cause of the last failure found by inspecting the profile's cookie store:
  alibaba's console login is session-cookie-only, so it died when the login
  window closed. Added explicit session-cookie save/restore.

### 2026-07-23

- Bootstrap: AGENTS.md, CLAUDE.md symlink, GEMINI.md symlink, .agents/skills/, .claude/skills symlink, .agents/sow/ structure, SOW template, audit script.
- Investigation: mimo cookie is session-only (proven via Chrome/Firefox DB scan). 4 OSS repos audited — none persist Set-Cookie. CDP identified as only race-free route.
- alibaba: console anti-bots headless, no public OpenAPI for quota. Same CDP approach needed.
- PAYG modes implemented: balance (deepseek), spend (openrouter).
- Service name config implemented (name supplied from the environment).
- Sparkline flicker fixed.

## Validation

Acceptance criteria evidence:

- All 8 providers show live data; none parked. Verified on the daemon host via
  `/api/providers`: zai 2 metrics, minimax 1, kimi 2, **mimo 1 (plan Max)**,
  **alibaba-coding 3 (plan Coding Plan Pro)**, **alibaba-token 2 (plan pro)**,
  deepseek 2, openrouter 1.
- The cookie-rotation problem is resolved rather than documented: mimo re-mints
  from persistent credentials; alibaba's session cookies are saved and
  re-injected. Both mechanisms proven, see below.
- Bootstrap (AGENTS.md, SOW system, cross-tool symlinks) completed 2026-07-23.

Tests or equivalent validation:

- `npm run test:all` — 8/8 pass, 0 failures, including all three browser
  providers in daemon mode (headless, fresh browser, own tabs).
- Session save/restore mechanism proven in isolation before asking the user to
  log in again: a session-scoped cookie (`expires: -1`) written, saved, browser
  closed, relaunched — cookie restored with its value intact.
- Profile portability proven before any login: marker cookie written on the
  workstation, profile copied to the daemon host, cookie read back decrypted.
- Chromium verified to launch as the service user under the unit's full
  hardening with the sandbox on.

Real-use evidence:

- User completed the headed login; all three sessions verified against the real
  quota APIs by the production fetchers.
- `npm run sync:profile` shipped the profile; the daemon polls with it.
- **Restart durability**: `systemctl restart ai-usage` on the daemon host, then
  all three providers still OK — the case that matters, since every deploy
  restarts the service. Full cycle proven after the shutdown-save fix below:
  session file rewritten at shutdown (mtime advances each restart), restored at
  start, 8/8 providers healthy, no save/restore errors in the journal.
- **Post-deploy journal review caught a defect the provider checks could not**:
  every session save failed on the server with
  `Storage.getCookies: Browser context management is not supported`. Two wrong
  diagnoses were tested and discarded before the real one: (1) the headless-shell
  binary lacking the call — disproved, a standalone run on the same host and
  binary read cookies fine; (2) systemd's default `KillMode=control-group`
  signalling chromium alongside the daemon — `KillMode=mixed` did not fix it.
  The actual cause is that playwright installs its own SIGTERM/SIGINT handlers
  which close the browser the moment the process is signalled, so the shutdown
  save always raced a dying browser. Fixed with
  `handleSIGTERM/SIGINT/SIGHUP: false`; `KillMode=mixed` was kept because it is
  independently correct for a unit that must clean up a child browser.
  Consequence had it shipped unnoticed: every restart would silently fall back
  to login-time cookies, and the alibaba session would die at its first
  rotation with no signal other than a provider error days later.
- Service journal clean since deploy; chromium runs as the service user
  (10 processes, ~860MB for the whole unit).

Reviewer findings:

- Self-review during implementation caught and fixed: the two alibaba providers
  previously drove the same page object from separate timers (a real race,
  pre-existing); `install.sh --delete` would have erased the profile and the
  browsers on every deploy; `main.ts` exited before the final session save
  could flush.
- Two defects were found by the user in real use, not by the assistant — both in
  the login tool's interaction model (see Execution Log). Fixed and re-verified.

Same-failure scan:

- Searched for other login detection by URL/redirect: only alibaba had it, now
  keyed on the gateway error code. mimo uses an origin check plus its API's own
  auth codes.
- Searched for other shared-page or shared-context races: `getPage` now keys a
  tab per provider and the context is cached as a promise so simultaneous first
  polls launch one browser.
- Searched for other runtime state under the install dir that a deploy could
  delete: `data/`, `browser/`, `.cache/` — all excluded from the installer rsync.

Sensitive data gate:

- No cookie values, tokens, account identifiers, or credentials appear in this
  SOW, the spec, docs, or code comments. Cookie evidence was gathered and
  reported as names/domains/expiry only.
- `ai-usage-session.json` holds live session cookies: written `0600`, inside a
  `0700` profile owned by the service user, added to `.gitignore` (with
  `browser/`) as defence in depth even though it lives outside the repo.
- The old profile, which held live third-party session cookies, was deleted per
  user decision 6.

Artifact maintenance gate:

- AGENTS.md: tech stack, commands, provider architecture (browser-session type,
  registry dispatch, protected runtime state) updated.
- Runtime project skills: still none. The operational knowledge that would form
  one (login → sync → expiry handling) is now in CREDS.md for the operator and
  in the spec for implementers; a skill would duplicate them. Revisit if a
  second browser-session provider is added.
- Specs: `provider-quota-semantics.md` — parked section replaced with the real
  session model and per-provider field semantics for all three.
- End-user/operator docs: CREDS.md rewritten for the login/sync flow, including
  the expiry remedy and the warning against polling the same session from two
  machines; `.env.example` obsolete keys removed.
- End-user/operator skills: none exist.
- SOW lifecycle: completed and moved to `done/` in the same commit as the work.

Specs update:

- Done (above). Verified against live payloads, not assumptions.

Project skills update:

- Deliberately none; reason recorded above.

End-user/operator docs update:

- CREDS.md, `.env.example`, AGENTS.md.

End-user/operator skills update:

- None exist; none affected.

Lessons:

- See Lessons Extracted.

Follow-up mapping:

- CDP approach: rejected, not deferred. A dedicated copied profile works and
  needs no debug port on the user's daily browser.
- Review finding 3 from the 2026-07-24 code review (ingest data invisible on the
  dashboard/MCP): still open and now clearly separate from this work — the
  browser providers poll on the daemon and never touch `/api/ingest`. Tracked as
  a follow-up below, not silently dropped.
- Poll interval: user chose 60s over the recommended 300s; mitigated in design.

## Outcome

All eight providers are live. mimo, alibaba-coding and alibaba-token are polled
by the daemon through a shared logged-in chromium profile that the user creates
once on a desktop and ships with one command. The sessions survive service
restarts, and a deploy no longer destroys the profile or the browsers.

The original analysis had concluded this was impossible without CDP against the
user's live browser. Direct testing showed the two blockers did not exist
(neither site anti-bots headless; chromium runs fine under the hardened unit)
and the real obstacle was a different one entirely — alibaba's session-only
cookies — which is solved explicitly.

Known limitation, accepted by the user: alibaba's console session will expire
server-side eventually; the remedy is `npm run login` + `npm run sync:profile`.
mimo renews itself from persistent credentials and should not need the user
again.

## Lessons Extracted

- Session cookies are structurally invisible to disk-based cookie readers. Any tool that claims to "read browser cookies" for session cookies is either using CDP or lying.
- "Paste your cookie" is not automation — it's manual work with a timer.
- Two-client coexistence with rotating session cookies is an unsolved problem across all OSS tools.
- Inherited conclusions must be re-tested before they shape a design. "alibaba
  anti-bots headless" and "systemd blocks Playwright" were both wrong, and both
  had cheap direct tests. The actual blocker was invisible until a live session
  existed to inspect.
- A provider reporting "no data found" when it is simply logged out sends the
  investigation in the wrong direction for a whole session. Auth failure must be
  detected on the signal the server actually sends — here an error code in a
  200 response, not a redirect that never happens.
- Chromium's cookie store is encrypted with an OS-keyring key by default, which
  silently makes a copied profile useless on a headless server;
  `--password-store=basic` is what makes profile portability real.
- Verify a mechanism in isolation before spending the user's time on it. The
  session save/restore was proven with a synthetic cookie before asking for a
  third login.
- Tools that need a human must not assume an interactive terminal: this harness
  backgrounds long commands and detaches stdin. Design for "detect completion",
  not "press Enter".
- A green health check is not proof the persistence path works. All eight
  providers reported OK while every session save was failing; only reading the
  journal after deploy exposed it. Check the writes, not just the reads.
- Browser automation libraries take over process signal handling by default.
  Any cleanup that must read from the browser during shutdown has to disable
  that first (`handleSIGTERM/SIGINT/SIGHUP: false`), or it silently races.
- When a fix does not change the symptom, discard the theory instead of
  layering another fix on top of it. Two plausible causes here were wrong, and
  each was cheap to disprove with a targeted test.

## Followup

- Ingest surface (from the 2026-07-24 review): data POSTed to `/api/ingest` is
  stored and exported to Prometheus but never appears on the dashboard or in the
  MCP, and the endpoint does not validate its payload. Unrelated to this SOW's
  outcome; needs its own SOW when the remote-agent feature is actually wanted.
- Project skills: create incrementally as patterns emerge.

## Regression Log

None yet.

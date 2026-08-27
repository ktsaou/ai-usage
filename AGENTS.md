# ai-usage — Agent Instructions

## Goals

AI subscription usage monitor daemon. Polls multiple AI provider APIs (z.ai, minimax, kimi, mimo, deepseek, openrouter, alibaba) for remaining quota/balance, stores history in SQLite, exposes Prometheus metrics, an MCP server, and a web dashboard. Runs as a systemd service under its own unprivileged user, installed to `/opt/ai-usage`.

Partially implemented: remote agents can POST usage data to `/api/ingest`, and it is stored and exported to Prometheus, but ingested providers do not appear on the dashboard or in the MCP, and the endpoint does not validate its payload. Do not treat it as a working feature.

**This repository is public.** Never commit host names, addresses, account identifiers, credentials, cookies, or anything else that identifies real infrastructure — including in SOWs, specs, and code comments. Deployment targets come from `.env` or arguments, never from committed defaults. Write instructions generically so they hold for any deployment.

## Tech Stack

- TypeScript (tsx runtime, no build step for dev)
- Hono HTTP server
- node:sqlite (built-in, no native deps)
- MCP SDK for stdio MCP server
- Patchright (playwright fork) driving a logged-in chromium profile for the
  browser-session providers (mimo, alibaba)
- systemd service (`ai-usage.service`)

## Commands

```bash
npm start              # daemon on :9199
npm run dev            # daemon with watch
npm run mcp            # MCP stdio server
npm run agent          # remote agent (reads Claude/Codex OAuth, POSTs to daemon)
npm run login          # headed login for the browser-session providers (needs a screen)
npm run sync:profile   # copy the logged-in profile to the daemon host, restart, verify
npm test               # unit tests (risk model + history queries), no network
npm run test:all       # live-fetch all non-parked providers; exits non-zero on failure
npm run test:all zai   # test one provider by id (parked ones only run when named)
sudo bash install.sh   # install to /opt/ai-usage, create user, enable service
```

## Configuration

- `config.json` — providers, service name, ingest keys, PAYG modes
- `.env` — secrets (API keys, cookies). Never committed. See `CREDS.md` for instructions.
- Config supports `${ENV_VAR}` interpolation for any string value.

## Provider Architecture

Every provider is dispatched through the registry in `src/providers/fetch.ts`; browser-based ones live in their own modules but are registered there too, so the scheduler and the test harness never special-case a provider type. The scheduler polls non-parked providers on `pollIntervalSeconds` (default 60s). Results are stored in SQLite and exposed via `/api/providers`, `/api/summary`, `/api/history/:id`, `/metrics`, and the dashboard.

Provider types:
- **Subscription quota** (zai, minimax, kimi, mimo, alibaba): used/total/remaining/percent per window
- **Pay-as-you-go** (deepseek, openrouter): configured via `payg` field — `balance` (remaining $ + runway), `spend` (window spend + pace), `budget` (spend vs cap)
- **Browser-session** (mimo, alibaba-coding, alibaba-token, flagged `playwright: true`): no usable API key; polled through one shared logged-in chromium profile (`src/providers/browser.ts`), one tab per provider. The user creates the profile with `npm run login` on a desktop and ships it with `npm run sync:profile`. Alibaba's console login is session-cookie-only, so those cookies are saved into the profile and re-injected on launch — without that the session dies on every restart. Read the session model in the spec before touching these.
- **Parked** (`parked: true`): not polled, muted on the dashboard, hidden from the MCP. Nothing is parked today.

Runtime state on the daemon host lives under `/opt/ai-usage`: `data/` (SQLite), `browser/profile` (the logged-in profile, `0700`), `.cache/ms-playwright` (chromium). `install.sh` must never delete these — they are excluded from its rsync.

Per-provider field semantics (metric names, units, windows, reset-time source, unlimited quotas) are documented in `.agents/sow/specs/provider-quota-semantics.md` — the source of truth when changing fetchers or MCP/dashboard rendering.

A metric may carry `note`, `breakdown`, `secondary`, `rolling`, `backstopped`, `expiresAt` and `coversUntil`, and a result may carry `subscription` — descriptive fields set by the provider module, passed through the API, and never stored. `secondary` means "this measures something other than the plan's usage"; `backstopped` means "this window is spent but another pool covers it, so it is not the constraint". Neither may headline a card or drive the provider's risk. Only the fetcher knows either, so renderers must never special-case a metric name to decide it. **A card is one headline window plus one row per other window, and each window appears exactly once.** The headline is the window `computeProviderRisk()` finds binding — the same one the verdict, the burn line, the chart and the footer countdown all describe — so the block reads as one statement about one quota. `primaryMetric()` (duplicated in `src/server.ts` and `src/dashboard.html`, which has no build step and cannot import — change both together) is only the fallback for pay-as-you-go providers, which have no binding window.

**A pool bought on top of a plan is a reserve, and a reserve is only a constraint while it is the thing paying.** Alibaba's extra packs are emitted `secondary` while no plan window is spent, and not emitted at all once their credits are gone: an empty reserve supplies nothing and is indistinguishable from owning no packs. Emitting it as an ordinary quota reported a working subscription `at risk` on both the dashboard and the MCP for as long as the pool stayed empty — the plan window it had covered was reset and paying again, and every surface still pointed at the pool. Only the fetcher can tell a reserve from a balance, so the three states are decided in `addonPoolMetric()`, never by the risk model and never by a renderer.

Headlining the fullest window instead was tried and failed twice. The two rules disagree regularly — two of seven providers in one live reading — and when they did, the binding window was not the headline, so it appeared *again* as a sub-row with its own countdown. Labelling every countdown with its window was the first attempt and was not enough: the user's complaint was two rows for one quota, not an ambiguous time. Naming things more precisely does not fix a card that is structurally about two windows at once. Anything added to a card must belong to exactly one window's row.

A vendor's APIs can contradict each other, and the one you can reach may be the wrong one. Alibaba's `autoRenewFlag` disagreed with its own billing system about whether a plan renews, and the monitor confidently told the user a renewing plan was about to lapse. Before reporting a fact that a user will act on, check it against what their console displays; where they disagree and the authoritative source is unreachable, report nothing rather than the reachable guess.

Every quota is judged against a deadline — the burn rate means nothing on its own. Most have one (their reset); a rolling window uses its own length; a pool that backstops a spent window borrows the reset of the window it covers (`coversUntil`), because that is the moment it has to reach. A quota with no deadline cannot be judged by pace at all, and falls back to its raw fill level. That fallback is right for a prepaid balance, where being nearly spent *is* the signal, and wrong for a reserve nobody is drawing on — so when adding a metric with no deadline, say which of the two it is.

Before adding a field, check what the vendor's console actually shows. One provider's quota reads 100% while the work continues from packs bought separately, reported by an endpoint the fetcher never called; the monitor said "blocked" for as long as nobody looked. When a card contradicts the vendor's own page, the missing data is usually one API call away — capture the console's traffic rather than guessing (see SOW-0008 for the method).

## Exhaustion Risk

Every quota metric carries a burn rate, the headroom it implies in hours, and a risk level, computed in `src/risk.ts` and served on `/api/providers`, `/metrics` and the MCP. The model, its parameters and the backtest that chose them are in the spec. Three rules that are easy to break:

- **Rates are measured within one window instance.** A pair of samples spanning a reset reads the drop to zero as a rate. `db.metricAnchors()` constrains on `resets_at` for exactly this reason.
- **A window that "refreshes" is not necessarily a window that resets.** One provider reports a trailing 5h window whose refresh time is always *now*; extrapolating that to a reset is meaningless, and treating it as a reset pinned the dashboard's next-reset tile to zero. Check whether `used` ever falls before believing a reset timestamp. Fetchers declare this with `rolling: true` and emit no `resetsAt`.
- **The parameters came from a backtest over real stored history**, not from taste. Re-run it before changing them: replay `/api/history/:id?days=14` into a temp database, walk the samples, and weigh warnings before real exhaustions against how much of the time the alarm is on. Tuning by intuition produces something that either never fires or is permanently amber.

Risk is derived once per poll in the scheduler and cached. Never move it into a request handler: the dashboard is meant to stay open, so per-request work is paid per viewer per minute, forever.

Unit tests run with `npm test` (`node --test`, no framework). They cover the model and the SQL that feeds it; the live providers stay in `npm run test:all`.

## Serving Cost

The dashboard is meant to stay open on a screen indefinitely. Both what it
transfers and what it burns while nobody touches it are *recurring* costs.

### Idle cost

Measured with a headless browser sampling the whole chromium process tree
(`scratchpad` harness, 25-40s windows): the page cost **9.5% of a CPU core doing
nothing**, and now costs **0.3%** — the same as a page with no timers at all.

- **No continuously running animation, anywhere.** A CSS `transition` or an
  infinite `animation` makes the browser produce frames forever. The single
  worst offender was a `transition:width` on the 2px refresh line: 6.9% of a
  core on its own, because animating width repaints a blurred glow 60×/second.
  Pulsing status dots cost another 1.5%.
- **Step, don't animate.** The refresh line advances in 1-second increments and
  reads as alive exactly the same. A GPU-composited `transform` version was also
  tried and still cost 2.5% — the compositor runs whether or not the main thread
  does. Stepping is the only approach that reaches the floor.
- **One timer for everything on the second, one for the data.** Four intervals
  became two; the per-second work (clock, countdowns, refresh line) totals
  ~0.2% of a core.
- Measure before and after with the CPU harness rather than reasoning about it.
  What looked cheap (the 1s timers) was noise; what looked decorative (a 2px
  line) dominated.

### Transfer cost

The dashboard refreshes every 60s per open tab, so a response size is paid
again every minute, per viewer.

- **The page may only fetch derived data.** It calls `/api/providers` and
  `/api/summary`; both are small and bounded. Raw samples are never sent to a
  browser — `/api/history/:id` exists for manual export and returns the full
  range, so nothing on a timer may call it.
- **Anything a card needs from history is computed in `db.ts` and served
  pre-reduced.** Sparkline points and the two samples a burn rate is measured
  between are queried with `LIMIT`, not filtered client-side from a full dump.
  A rewrite that sends rows and lets the page pick will not be noticed in
  testing — it costs nothing on a LAN and saturates the link in production.
- **Serialise at the precision the pixel can show.** One provider reports
  percentages to 15 significant digits. Sending the card's series unrounded cost
  more than the entire rest of the response — rounding to 4 decimals took
  `/api/summary` from 1594 to 992 bytes gzipped and changed nothing on screen.
- **Each card's chart carries one series, and the second is derived from it.**
  The bars are per-minute consumption, which is exactly the first difference of
  the level line; sending both would ship the same information twice and let the
  two disagree. Deriving is not a licence to send raw rows and reduce in the
  page — the series itself is still `LIMIT`-queried and pre-reduced in `db.ts`.
- Responses are gzipped (`compress()` in `src/server.ts`). It is a safety net
  for the remaining endpoints, not a substitute for sending less.
- **The overview strip is a fixed 1196px however wide the window is** (the page
  is capped at 1240px), while its six tiles are sized by provider names and
  figures, which are data. Sized to content they eventually overflow and one
  wraps onto a second row — it took only 17px. The tiles therefore carry
  `flex: 0 1 auto; min-width: 0` so they give up width and reflow their own
  captions instead; `min-width: 0` is load-bearing, because a flex item's
  automatic minimum otherwise pins it to its longest line. Below 900px there is
  no width left to share and wrapping is restored. Adding a seventh tile, or a
  longer caption, needs the row re-measured at 1280px and at 1000px.
- Charts were removed once, then one came back deliberately: a bounded 120-point
  strip per card, agreed with the user, costing +92 bytes gzipped per refresh
  over the whole payload. That budget is what made it acceptable. Do not
  reintroduce a view that needs a time series without agreeing its cost first,
  and do not grow this one without measuring again.
- Samples older than `retentionDays` (config, default 90) are deleted daily.
  A poll every minute writes ~18k rows/day; without pruning the database grows
  ~1.1 GB/year. No VACUUM: freed pages are reused, so the file settles.

## Working On Browser-Session Providers

These providers have no usable API key: their numbers exist only inside a web
console, so the daemon drives a real logged-in browser profile. This is the
fragile part of the project. Read this section and the spec's session model
before changing anything under `src/providers/browser.ts`, `mimo.ts`,
`alibaba.ts`, `src/login.ts`, or the service unit.

### Operator flow

1. `npm run login` on a machine with a screen — one shared profile, one tab per
   site, verified by calling the real quota APIs through the production
   fetchers. A pass therefore means the daemon will work, not just that a page
   looked logged in.
2. `npm run sync:profile` — copies the profile to the daemon host, restarts the
   service, reports what each provider returns.
3. When a session dies, the provider reports `session expired`; the remedy is
   those same two commands.

### Invariants that fail silently if broken

- `--password-store=basic` on every launch. Chromium otherwise encrypts its
  cookie store with an OS-keyring key, and a profile copied to a headless
  server decrypts to nothing.
- `handleSIGTERM/SIGINT/SIGHUP: false` on launch. Playwright's own signal
  handlers close the browser before shutdown can read cookies out of it.
- The profile directory must be writable by the service (`ReadWritePaths`).
  These sites rotate session cookies, and a read-only profile loses the session
  within hours.
- The installer must never delete runtime state (`data/`, `browser/`,
  `.cache/`); it uses `rsync --delete` and excludes them explicitly.
- One tab per provider, never a shared page: providers poll on independent
  timers and would otherwise navigate each other's page mid-request.
- The login tool must stay passive while the user signs in — no opening tabs, no
  navigating. It probes only the tabs the user already has open.
- Never poll the same session from two machines at once. Whichever rotates the
  cookies last leaves the other logged out.
- A tab is only reusable while its *document* is usable on the target origin —
  never decide that from `page.url()`, which keeps reporting the last URL the
  automation library saw committed. A navigation that fails after commit leaves
  the tab reporting the right URL while the live document is the browser's error
  page, whose origin is opaque; every cookie read then throws `SecurityError`
  forever, because nothing re-navigates a tab whose URL looks correct.

### Session models differ per provider — check before assuming

Some sites keep persistent credentials and re-mint a short-lived token on each
visit; those sessions survive restarts on their own. Others keep the entire
login in session cookies, which the browser destroys on exit; those must be
saved and re-injected (`ai-usage-session.json` inside the profile, rewritten
periodically and on shutdown) or they die on every restart. Determine which
kind a provider is by inspecting the profile's cookie store — names, domains
and expiry only, never values — rather than guessing.

Sessions of the second kind also *end*, and the lifetime is the site's to
decide. One was measured at 48h to the minute from sign-in — twice, and the
second time despite the tab being revisited every 6h in between — while polls
ran every 60s without a gap. So it is an absolute lifetime: not an idle
timeout, not extendable by use, restarts or code. Measure it the same way
before theorising:
the site usually sets a batch of long-lived cookies at sign-in whose expiry
stamps reveal exactly when the session was created, and the journal shows the
last success and first failure.

Because polls are same-origin XHRs, the site otherwise never sees a page visit
after the first load, so a session that renews on a visit and one with a fixed
lifetime look identical. Each tab is therefore revisited every
`TAB_REFRESH_MS` (6h; override with `AI_USAGE_TAB_REFRESH_MS`), lazily inside
the provider's own poll — never on a timer, which would navigate a tab out from
under an in-flight request. That revisit did **not** extend the session; it is
kept only because a periodic visit is useful to have.

A fixed lifetime does not have to mean a human signs in again. Where the console
offers a third-party sign-in whose own session outlives it by a wide margin, the
daemon re-authenticates itself: on a logged-out gateway reply it navigates
straight to the sign-in link's `href`, which completes the OAuth round trip
against the stored identity session and lands back on the console. Attempts are
single-flighted (two providers share one console) and rate limited, and the
operator-facing error only appears once that has also failed. Two things make
this work and are easy to get wrong: **do not click the button** — the login
page carries an anti-bot overlay that covers it headlessly, while the link's
`href` bypasses the page entirely; and pass the console URL as the sign-in's
callback parameter so the tab lands where the poll expects it.

### Debugging rules learned the hard way

- **Auth failure is not "no data".** These consoles answer HTTP 200 while
  logged out and signal it in a body field; one returns an error code, another
  is detected by the tab sitting on a different origin. Never detect login
  state by waiting for a redirect — these consoles do not redirect.
- **Green providers do not prove the persistence path works.** All providers
  reported healthy while every session save was failing. After any change to
  browser or shutdown code, read the service journal for save/restore errors
  and confirm the session file's timestamp advances across a restart.
- **Verify a restart, not just a poll.** Every deploy restarts the service, so
  "works now" is worthless if the session does not survive `systemctl restart`.
- **Prove a mechanism in isolation before asking the user to log in.** Their
  time is the scarce resource; synthetic cookies can validate save/restore
  without any credentials.
- **Interactive tools cannot assume a terminal.** Long commands may be
  backgrounded with stdin detached, so anything waiting on "press Enter" hangs
  and the process exits unfinished. Detect completion instead of prompting.
- **If a fix does not change the symptom, discard the theory.** Do not stack
  another fix on top of an unproven one.
- **Transient network faults are permanent bugs unless a poll can heal them.**
  A daemon that starts while its host's network is still settling will see loads
  fail; anything that then keeps a broken tab, page or client forever turns a
  few seconds of trouble into an outage that only a restart clears. Every poll
  must be able to rebuild what it needs.
- **Reproduce the failure deterministically before fixing it.** A local server
  that refuses connections, or a dead hostname navigated to after a good load,
  reproduces both shapes of this failure in seconds with no credentials — and it
  is the only way to know a fix works, because restarting the service clears the
  symptom whether or not the fix is correct.

### Settled questions — do not re-investigate without new evidence

Recorded because a previous iteration built a whole design around assumptions
that were never tested, and all of them were wrong:

- Neither console blocks headless browsers, and neither does the quota API
  behind them. Both were probed directly. **Their login pages are a different
  story**: one puts an anti-bot overlay over the sign-in controls, so anything
  that has to interact with a login *page* headlessly should be assumed
  contested, and reached by URL rather than by clicking.
- Chromium runs fine as the service user under the unit's full hardening, with
  the sandbox enabled and no `--no-sandbox`, including on distributions that
  restrict unprivileged user namespaces.
- A copied profile works; CDP against a human's daily browser is not needed.
- Neither vendor exposes these quotas through a public API. Cookie-pasting from
  `.env` cannot work, because the tokens involved are session-scoped and
  re-issued per visit.

## SOW System

This project uses a local Statement of Work system.

The SOW system is self-contained in this repository. Normal SOW work must not depend on `~/.agents`, `~/.AGENTS.md`, global skills, global templates, or global scripts. Use this `AGENTS.md`, project-local SOW files, project-local specs, project-local skills, and the active SOW.

### Roles

- **User responsibilities:** purpose, scope decisions, design forks, risk acceptance, destructive approvals, and final product judgment.
- **Assistant responsibilities:** investigation, evidence, implementation, tests or equivalent validation, reviews, documentation, memory updates, and concise reporting.

### Required First Checks

Before creating a SOW or starting non-trivial implementation:

1. Confirm the user has requested implementation.
2. Inspect code/docs/data to establish whether a change is needed.
3. Read pending/current SOWs for overlap, contradictions, and existing decisions.
4. Read relevant specs under `.agents/sow/specs/`.
5. Inspect `.agents/skills/project-*/SKILL.md` and load every runtime project skill whose trigger matches the work.
6. Ask the user only for irreducible product/design/risk decisions.

### Git Worktrees

Assistants must not create git worktrees on their own. Create a git worktree only when the user explicitly asks for it or approves it.

### Sensitive Data In Durable Artifacts

SOWs, specs, documentation, project skills, agent instructions, and code comments are commit-ready artifacts. Treat them as public unless a repository-specific policy explicitly says otherwise.

CRITICAL: Never write raw sensitive data to durable artifacts. This includes passwords, API keys, bearer tokens, SNMP communities, private keys, connection strings with embedded credentials, session cookies, community member names, customer names, customer identifiers, personal data, non-private IP addresses that can identify customers, private endpoints, account IDs, and proprietary incident details.

Write only sanitized evidence:

- use placeholders such as `[REDACTED_SECRET]`, `[CUSTOMER]`, `[ACCOUNT]`, `[PRIVATE_ENDPOINT]`;
- use stable aliases such as `customer-a` only when the real mapping is not stored in the repository;
- cite file paths, line numbers, command names, schema fields, or error classes instead of copying sensitive values;
- summarize logs and traces; include only minimal redacted snippets.

If sensitive data is required to continue, stop and ask the user for a secure handling path. If sensitive data is found in a durable artifact, sanitize it before any commit. If sensitive data was already committed, tell the user and do not rewrite history without explicit approval.

### Open-Source Reference Evidence

When a SOW uses external open-source repositories as evidence, record the upstream repository identity and checked commit, not the workstation mirror path.

For local mirrored or cloned open-source repositories, cite evidence in this form:

```text
owner/repo @ commit
relative/path/inside/repo:line
```

Rules:

- Never use workstation absolute paths for external open-source evidence in SOWs.
- Resolve `owner/repo` from the repository remote, not only from the local directory name.
- Record the commit with `git -C <repo> rev-parse --short=12 HEAD` or the full hash when precision matters.
- Use paths relative to the upstream repository root after the `owner/repo @ commit` line.
- If multiple repositories were checked, list each repository and commit separately.

### Pre-Implementation Gate

Implementation covered by a SOW must not begin until the SOW contains a concrete `## Pre-Implementation Gate` section. Before moving a SOW from `pending/open` to `current/in-progress`, or before continuing implementation in an existing current SOW that lacks this section, fill the gate.

The gate must record:

- Problem / root-cause model: what is happening, why it is happening, and what evidence supports that model.
- Evidence reviewed: specs, code, docs, tests, logs, traces, prior SOWs, issues, or external references checked. Open-source references from local mirrors or clones must be cited as `owner/repo @ commit` plus repository-relative paths, never as workstation absolute paths.
- Affected contracts and surfaces: APIs, schemas, files, commands, UI, docs, specs, skills, tests, integrations, operators, users.
- Existing patterns to reuse: local modules, helpers, conventions, tests, and docs that should shape the implementation.
- Risk and blast radius: regressions, compatibility, performance, security, data loss, migration, rollout, and operational risks.
- Sensitive data handling plan: whether the work may expose secrets, credentials, bearer tokens, SNMP communities, community/customer data, personal data, non-private customer-identifying IPs, private endpoints, or proprietary incident details; how evidence will be redacted in SOWs, specs, docs, skills, instructions, and code comments.
- Implementation plan: ordered chunks with scope, dependencies, and files or modules likely to change.
- Validation plan: tests, fixtures, manual checks, real-use evidence, review passes, and same-failure searches.
- Artifact impact plan: expected updates to `AGENTS.md`, runtime project skills, specs, end-user/operator docs, end-user/operator skills, and SOW lifecycle.
- Open decisions: resolved decisions or numbered options for the user; unresolved decisions block implementation.

Generic placeholders such as `TBD`, `N/A`, or "to be checked later" are invalid unless the SOW explains why the item truly does not apply. If the gate exposes an unknown that cannot be resolved by investigation, stop and ask the user before implementation.

### When A SOW Is Required

Create or reuse a SOW only after the user requests implementation and preliminary analysis confirms a non-trivial change is needed.

Questions, discussions, reviews, status reports, and read-only investigation do not need a SOW. Trivial implementation such as typo or formatting-only fixes does not need one.

When unsure whether a change is needed, investigate first. When an authorized change has unclear risk, treat it as non-trivial.

### SOW Locations

- Pending: `.agents/sow/pending/`
- Current: `.agents/sow/current/`
- Done: `.agents/sow/done/`
- Specs: `.agents/sow/specs/`
- Template for new SOWs: `.agents/sow/SOW.template.md`
- Local audit: `.agents/sow/audit.sh`

Create new SOW files from `.agents/sow/SOW.template.md`. The template is project-local and may be customized for this repository.

Empty SOW directories must contain `.gitkeep` or `.keep` so the committed repository preserves the full SOW layout after clone/checkout.

Filename:

```text
SOW-NNNN-YYYYMMDD-{slug}.md
```

Status and directory must agree:

- `open` lives in `pending/`
- `in-progress` lives in `current/`
- `paused` lives in `current/`
- `completed` lives in `done/`
- `closed` lives in `done/`

### SOW Completion And Commit

The successful terminal SOW status is `completed`. `done` is a directory name, not a status value. Never write `Status: done` or `Status: complete`.

When a SOW's work is ready to close:

1. Finish implementation, docs, specs, skills, validation, and follow-up mapping.
2. Update the SOW to `Status: completed`.
3. Move the SOW file to `.agents/sow/done/`.
4. Commit the work, artifact updates, SOW status change, and SOW move together as one commit, unless the user explicitly requested a different commit split.

Do not create a separate commit just to mark or move the SOW. Do not claim a SOW is completed while the implementation and the SOW lifecycle change live in separate uncommitted or separately committed states.

### One SOW At A Time

Never execute multiple SOWs as one batch.

If work overlaps:

- merge or consolidate before implementation; or
- split into separate SOWs and complete one before starting the next.

Progress reports are not stop points. Once a SOW is in progress, continue until it is delivered, failed with evidence, blocked on a real user decision/approval, or superseded by newer user instructions.

### User Decisions

When user decisions are needed:

1. Present concrete evidence with files/lines or source references.
2. Provide numbered options.
3. Explain pros, cons, implications, and risks.
4. Recommend one option with reasoning.
5. Record the user's decision in the SOW before implementation.

### Followup Discipline

"Deferred" is not a terminal outcome.

Before a SOW can close, every valid deferred item must be:

- implemented in the current SOW; or
- explicitly rejected as not worth doing, with evidence; or
- represented by a real pending/current SOW file.

Pre-close, search the SOW for:

```text
defer|later|follow-up|future|TODO|pending
```

Map every remaining item to implemented, rejected, or tracked.

### Regressions

A regression is discovered after a SOW was considered completed or closed, later testing or use finds broken behavior, and the original SOW's claimed outcome is no longer true.

When behavior that a completed SOW claimed working stops working:

1. Find the original SOW in `done/`.
2. Move it back to `current/`.
3. Mark it `in-progress` with a regression note in `## Status`.
4. Append a new dated `## Regression - YYYY-MM-DD` section at the end of the file, after the original outcome, lessons, and follow-up content.
5. In that appended section, record what broke, evidence, why previous validation missed it, the repair plan, validation, and updates needed to specs, skills, docs, audits, or follow-up SOWs.
6. Fix and validate there.

Never prepend regression content above the original SOW narrative. The original requirements, analysis, plan, validation, outcome, lessons, and follow-up must remain readable first.
Do not create a new SOW for a true regression.

### Validation Gate

A SOW cannot be completed until Validation records:

- acceptance criteria evidence;
- tests or equivalent validation;
- real-use evidence when a runnable path exists;
- reviewer findings and how they were handled;
- same-failure search results;
- sensitive data gate: durable artifacts contain no raw secrets, credentials, bearer tokens, SNMP communities, community member names, customer names, personal data, non-private customer-identifying IPs, private endpoints, or proprietary incident details;
- artifact maintenance gate for `AGENTS.md`, runtime project skills, specs, end-user/operator docs, end-user/operator skills, and SOW lifecycle;
- SOW status/directory consistency;
- spec update or specific reason no spec update was needed;
- project skill update or specific reason no skill update was needed;
- end-user/operator docs update or evidence-backed reason none were affected;
- end-user/operator skill update or evidence-backed reason none were affected by docs/spec changes;
- lessons extracted or specific reason there were none;
- follow-up mapping.

Generic "N/A" is invalid.

### Artifact Maintenance Gate

Every SOW close must explicitly record whether each durable artifact class was updated or why no update was needed:

- `AGENTS.md` - workflow, responsibility, local framework, project-wide guardrails.
- Runtime project skills - `.agents/skills/project-*/SKILL.md` for HOW to work here.
- Specs - `.agents/sow/specs/` for WHAT the project does.
- End-user/operator docs - README, docs site, runbooks, published guides, help text, or other human-facing documentation.
- End-user/operator skills - output/reference skills copied or consumed outside normal repo work.
- SOW lifecycle - split, merge, status, directory, deferred work, regression reopening, and follow-up mapping.

This is an assistant responsibility. If a SOW changes behavior, docs, specs, commands, schemas, defaults, workflows, examples, or operating procedure, the assistant must update every affected artifact in the same SOW, or record the evidence-backed reason an artifact is unaffected.

### Specs

Specs are memory of WHAT this project does.

Update specs when shipped work changes:

- product behavior;
- public contracts;
- data formats;
- UX rules;
- business logic;
- operational guarantees;
- known edge cases.

Specs describe current reality, not aspiration. If specs and code disagree, record the discrepancy in the active SOW and resolve or track it.

### Project Skills

Project skills are memory of HOW to work here.

Runtime input project skills should live under `.agents/skills/project-*/SKILL.md`. The `project-` prefix is the generic hook meaning "agents working in this repo must consider this skill." Before non-trivial implementation, inspect those skill descriptions and load every matching runtime skill. Skill descriptions are mandatory hooks, not suggestions.

Do not create generic `project-*` skills only to make the framework look complete. If this project intentionally grows project skills incrementally, record that in the active SOW and keep this section honest until concrete reusable knowledge exists.

### Project Skills Index

No runtime project skills yet. Skills will be created incrementally as concrete reusable knowledge accumulates. This decision is tracked in SOW-0001.

### Project-specific commands

See `## Commands` above.

### Project-specific overrides

None yet.

### Preservation Notes

No pre-existing agent files were present at bootstrap. AGENTS.md was created from scratch.

Project SOW status: initialized

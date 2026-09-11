# Credentials Guide

## ZAI_API_KEY

Your GLM Coding Plan API key.

- Go to https://z.ai → sign in → API Keys (or https://open.bigmodel.cn for CN)
- Create/copy your API key
- This is the same key you use in coding tools with base URL `https://api.z.ai/api/coding/paas/v4`

## MINIMAX_SUBSCRIPTION_KEY

Your Token Plan **Subscription Key** (NOT the regular pay-as-you-go API key).

- Go to https://platform.minimax.io → sign in → Account Management → API Keys
- The Subscription Key is separate from standard API keys
- It's the key you use in coding tools (OpenCode, Claude Code, etc.) for the Token Plan
- CN users: https://platform.minimaxi.com

## KIMI_CODING_API_KEY

Your Kimi **Code** platform API key (format: `sk-kimi-xxx`).

- Go to https://www.kimi.com/code → sign in → Console → API Keys
- Create a key — it will start with `sk-kimi-`
- ⚠️ This is NOT the same as the regular Kimi Open Platform key (`sk-xxx`) from platform.kimi.ai
- The two key types are completely independent and not interchangeable

## MiMo and Alibaba (Coding Plan + Token Plan)

These three have **no API key** that reports quota — the numbers exist only
inside their web consoles. They are polled through a browser profile you log
into once. Copying cookies by hand does not work: the tokens they use are
session-scoped and are re-issued per visit.

### One-time setup

On a machine with a screen (not the server):

```bash
npm run login        # opens a browser window with one tab per site
```

Sign in to each tab — Alibaba with Google, MiMo with your Xiaomi account.
A parked provider (`parked: true` in `config.json`, as MiMo is while its plan
is lapsed) gets no tab and is not waited for.
Nothing navigates while you work. The window closes by itself once every
session is verified against the real quota APIs, and prints your live numbers.

```bash
npm run sync:profile   # copies the profile to the daemon host and restarts it
```

Set the target host with `AI_USAGE_REMOTE` in your `.env` (not committed), or
pass it explicitly: `npm run sync:profile -- myhost`. The script stops the
service, copies, restores ownership, starts it again, and prints what each
provider reports.

### When a session expires

Normally you do nothing — both providers renew themselves:

- **MiMo** re-mints its short-lived token from a credential that lasts a month.
- **Alibaba's console session lasts exactly 48h from sign-in**, whether or not
  it is used. The daemon signs in again by itself, reusing the identity-provider
  session in the profile, which is good for about a year. The journal records
  `[alibaba] console session expired — signing in again`, one poll reports an
  error, and the next one is back to normal.

You are only needed when the automatic sign-in cannot work either — the identity
session itself expired, the password changed, or the provider now demands a
challenge. Then the provider shows `session expired and automatic sign-in did
not restore it — run npm run login, then npm run sync:profile`, and you repeat
the two commands above. Expect that roughly once a year, not every few days.

⚠️ After syncing, avoid running the browser providers locally
(`npm run test:all mimo`, `alibaba-coding`, `alibaba-token`) — the workstation
and the daemon would be using the same session cookies, and whichever rotates
them last leaves the other logged out. Use `npm run login` when you need to
re-authenticate.

### What is stored, and where

The profile lives at `~/.local/share/ai-usage/profile` on your workstation and
`/opt/ai-usage/browser/profile` (mode `0700`, owned by the service user) on the
daemon host. It holds live session cookies for those accounts, including
`ai-usage-session.json`. It is never committed and must not be shared.

## xAI SuperGrok (OAuth)

The subscription has **no API key** that reports its allowance: xAI's own coding
CLI reads it with the subscription's OAuth token, and so does the daemon, from
a credential file it refreshes by itself. An API key from console.x.ai is a
different product (pay per token) and is not used here.

### One-time setup

On your workstation:

```bash
npm run login:xai      # prints a URL and a code; no local browser needed
```

Open the URL anywhere, sign in with the account that holds the subscription,
enter the code. The command waits, then verifies the file against the real
billing endpoint and prints your live numbers.

```bash
npm run sync:auth      # moves the file to the daemon host and verifies the next poll
```

Set the target host with `AI_USAGE_REMOTE` in your `.env` (not committed), or
pass it explicitly: `npm run sync:auth -- myhost`. No restart is needed — the
daemon reads the file on every poll.

### When it expires

Normally you do nothing: the access token lasts six hours and the daemon
refreshes it in the poll that needs it. The refresh token rotates on every
refresh, which is why the file is **moved**, not copied, and why it must never
be shared with another consumer of the same account — whichever refreshes last
leaves the other logged out.

You are only needed when a refresh is refused (the token was revoked, the
sign-in was done elsewhere with the same file, or the password changed). Then
the provider shows `login required — run npm run login:xai, then npm run
sync:auth`, and you repeat the two commands above.

### What is stored, and where

`xai.json` under `~/.local/share/ai-usage/auth/` on your workstation until it
is moved, then `/opt/ai-usage/auth/xai.json` (mode `0600`, owned by the service
user) on the daemon host. It holds the live access and refresh tokens. It is
never committed and must not be shared.

## DEEPSEEK_API_KEY

Standard DeepSeek API key.

- Go to https://platform.deepseek.com → API Keys → Create
- This is the same key you use for API calls to `https://api.deepseek.com`

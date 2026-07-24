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

Sign in to both tabs — MiMo with your Xiaomi account, Alibaba with Google.
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

The affected provider shows `session expired — run npm run login, then
npm run sync:profile` on the dashboard and in the MCP. Repeat the two commands
above. Expect this occasionally for Alibaba, whose console login is
session-only; MiMo renews itself and should not need you again.

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

## DEEPSEEK_API_KEY

Standard DeepSeek API key.

- Go to https://platform.deepseek.com → API Keys → Create
- This is the same key you use for API calls to `https://api.deepseek.com`

import { chromium, type BrowserContext, type Page } from "patchright";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Providers that need a logged-in browser session share one persistent profile
// (created by `npm run login`, copied to the daemon host by scripts/sync-profile.sh).
// Each provider gets its own tab so concurrent polls never drive the same page.

export const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  // Chromium encrypts its cookie store with an OS-keyring key by default. The
  // headless daemon host has no keyring, so without the basic (deterministic)
  // store a copied profile loses every session cookie.
  "--password-store=basic",
];

export function profileDir(): string {
  return process.env.AI_USAGE_BROWSER_DIR || join(homedir(), ".local", "share", "ai-usage", "profile");
}

// Chromium drops session cookies when it exits. The alibaba console keeps its
// entire login in session cookies, so without carrying them across restarts the
// session dies with the browser — including on every deploy. They are saved
// here (inside the profile, so the profile sync carries them) and re-injected
// at launch. Contains live session tokens: keep it 0600 and never commit it.
function sessionFile(): string {
  return join(profileDir(), "ai-usage-session.json");
}

const SAVE_INTERVAL_MS = 5 * 60 * 1000;
let saveTimer: ReturnType<typeof setInterval> | null = null;

async function restoreSession(ctx: BrowserContext): Promise<void> {
  const file = sessionFile();
  if (!existsSync(file)) return;
  try {
    const saved = JSON.parse(readFileSync(file, "utf-8"));
    if (Array.isArray(saved.cookies) && saved.cookies.length > 0) {
      await ctx.addCookies(saved.cookies);
    }
  } catch (err: any) {
    console.error(`[browser] could not restore saved session: ${err.message}`);
  }
}

/**
 * Persist the context's session cookies. Called periodically so a daemon
 * restart resumes from the newest cookies rather than the ones captured at
 * login time, which the site may already have rotated away.
 */
export async function saveSession(): Promise<number> {
  const ctx = contextPromise ? await contextPromise.catch(() => null) : null;
  if (!ctx) return 0;
  try {
    // cookies() rather than storageState(): cookies are all that is restored,
    // and this avoids collecting per-origin storage the profile already keeps.
    const all = await ctx.cookies();
    // Only session-scoped cookies: persistent ones already live in the profile,
    // and re-injecting stale copies of those would overwrite fresher values.
    const cookies = all.filter((c) => !c.expires || c.expires === -1);
    writeFileSync(sessionFile(), JSON.stringify({ cookies }), { mode: 0o600 });
    return cookies.length;
  } catch (err: any) {
    console.error(`[browser] could not save session: ${err.message}`);
    return 0;
  }
}

let contextPromise: Promise<BrowserContext> | null = null;
const pages = new Map<string, Page>();

/**
 * Adopt an already-open context (the headed login window) so verification runs
 * against the same session. Chromium allows only one instance per profile, so
 * the login tool must share its context rather than let a second one launch.
 */
export function useContext(ctx: BrowserContext): void {
  contextPromise = Promise.resolve(ctx);
  pages.clear();
}

/** Bind an existing tab to a provider, so it is reused instead of opening another. */
export function adoptPage(key: string, page: Page): void {
  pages.set(key, page);
}

let passive = false;

/**
 * Passive mode: never open or navigate tabs, only use adopted ones. Used while
 * the user is signing in, so probing their session cannot disturb the window
 * they are typing into.
 */
export function setPassive(value: boolean): void {
  passive = value;
}

async function getContext(): Promise<BrowserContext> {
  // Cached as a promise so simultaneous first polls launch only one browser.
  if (!contextPromise) {
    contextPromise = chromium
      .launchPersistentContext(profileDir(), {
        headless: true,
        args: LAUNCH_ARGS,
        // Playwright would otherwise close the browser the instant the process
        // is signalled, before shutdown can read the session cookies out of it.
        handleSIGTERM: false,
        handleSIGINT: false,
        handleSIGHUP: false,
      })
      .then(async (ctx) => {
        await restoreSession(ctx);
        saveTimer ??= setInterval(() => void saveSession(), SAVE_INTERVAL_MS);
        saveTimer.unref?.();
        return ctx;
      })
      .catch((err) => {
        contextPromise = null;
        throw err;
      });
  }
  return contextPromise;
}

/**
 * Whether the tab really holds a usable document on `origin`.
 *
 * `page.url()` cannot answer this: it reports the last URL playwright saw
 * committed, so a navigation that fails after commit (the network changing
 * under the browser while the host boots) leaves it reporting the target URL
 * while the live document is chromium's error page — `location.href` is
 * `chrome-error://chromewebdata/` and the origin is opaque. Every provider then
 * throws `SecurityError` on its first cookie read, forever, because nothing
 * re-navigates a tab whose URL looks correct.
 *
 * So ask the document itself, testing the capability the callers need.
 */
async function usable(page: Page, origin: string): Promise<boolean> {
  try {
    return await page.evaluate((want) => {
      try {
        void document.cookie; // throws on an opaque (error page / blank) origin
        return location.origin === want;
      } catch {
        return false;
      }
    }, origin);
  } catch {
    return false; // closed or crashed renderer
  }
}

/** A tab dedicated to one provider, parked on `url`. Re-navigates if `force`. */
export async function getPage(key: string, url: string, force = false): Promise<Page> {
  const ctx = await getContext();
  let page = pages.get(key);

  if (passive) {
    if (!page || page.isClosed()) throw new Error("no signed-in tab yet");
    return page;
  }

  if (!page || page.isClosed()) {
    page = await ctx.newPage();
    pages.set(key, page);
  }

  // Navigate once per tab: the console SPA only has to bootstrap the session,
  // after which polls are same-origin XHRs from the already-open page. Anything
  // that left the tab without a usable document on the target origin gets it
  // re-navigated, which is what makes a failed load self-healing.
  if (force || !(await usable(page, new URL(url).origin))) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2000);
  }
  return page;
}

export async function closeBrowser(): Promise<void> {
  const ctx = contextPromise ? await contextPromise.catch(() => null) : null;
  if (ctx) await saveSession().catch(() => {});
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
  pages.clear();
  contextPromise = null;
  if (ctx) await ctx.close().catch(() => {});
}

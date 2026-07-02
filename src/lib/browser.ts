/**
 * Shared browser bootstrap.
 *
 * We use a PERSISTENT Chrome profile (a real user-data dir on disk) rather than
 * a storageState snapshot. Pocket Option's login doesn't reliably survive a
 * storageState export (auth spans several domains + short-lived tokens), so the
 * persistent profile is what lets you log in ONCE and have every later run —
 * and eventually the always-on VPS scanner — reuse the logged-in session.
 *
 * The profile dir (.auth/chrome-profile) is gitignored. It can be copied to the
 * VPS to carry the session across machines.
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import { paths } from '../config.js';

export async function openPersistentContext(opts: { headless: boolean }): Promise<BrowserContext> {
  fs.mkdirSync(paths.chromeProfile, { recursive: true });
  return chromium.launchPersistentContext(paths.chromeProfile, {
    headless: opts.headless,
    viewport: opts.headless ? { width: 1440, height: 900 } : null,
    // Reduce the "automation" fingerprint a little; PO is picky about bots.
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

/** The first page of a persistent context, creating one if none exists. */
export async function firstPage(context: BrowserContext): Promise<Page> {
  return context.pages()[0] ?? (await context.newPage());
}

/**
 * Best-effort dismissal of Pocket Option promo/ad modals so they don't sit over
 * the terminal. Non-fatal: unknown popups are left for you to close by hand.
 */
export async function dismissPopups(page: Page): Promise<void> {
  const closeSelectors = [
    '[aria-label="Close"]',
    'button[class*="close" i]',
    'div[class*="modal" i] [class*="close" i]',
    '.popup__close',
    '.modal__close',
  ];
  try {
    await page.keyboard.press('Escape').catch(() => {});
    for (const sel of closeSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
        await el.click({ timeout: 500 }).catch(() => {});
      }
    }
  } catch {
    /* popups are best-effort; ignore */
  }
}

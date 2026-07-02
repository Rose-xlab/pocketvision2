/**
 * Phase 1 — session capture (persistent profile).
 *
 * Launches a HEADED Chromium using a persistent profile so you can log in to
 * Pocket Option by hand (email/password, captcha, 2FA, and closing any promo
 * popups). We never see or store your password — everything is typed into
 * Pocket Option. When you press ENTER, the browser closes and the logged-in
 * session stays saved in the profile dir (.auth/chrome-profile, gitignored),
 * so `npm run spike` and later the scanner reuse it WITHOUT logging in again.
 */
import readline from 'node:readline';
import { config } from '../config.js';
import { openPersistentContext, firstPage } from '../lib/browser.js';

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function main() {
  const context = await openPersistentContext({ headless: false });
  const page = await firstPage(context);

  console.log(`\n→ Opening ${config.poBaseUrl}`);
  console.log('  Log in normally (email/password, captcha, 2FA, close any ad popups).');
  console.log('  Your password is typed into Pocket Option only; it is never read or stored here.\n');

  await page.goto(config.poBaseUrl, { waitUntil: 'domcontentloaded' });

  await waitForEnter('When you are logged in and see the trading terminal, press ENTER to save the session… ');

  // Persistent profile saves automatically on close — no storageState export needed.
  await context.close();
  console.log('\n✓ Session saved to the persistent profile.');
  console.log('  You stay logged in for future runs. Next:  npm run spike\n');
}

main().catch((err) => {
  console.error('Login capture failed:', err);
  process.exit(1);
});

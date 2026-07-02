/**
 * Phase 1 — feed-discovery spike (the gate for the whole project).
 *
 * Attaches a logged-in session (from `npm run login`) and listens to every
 * WebSocket the Pocket Option terminal opens. Each text frame is parsed,
 * redacted, and appended to logs/frames-<ts>.jsonl. A live analyzer counts
 * distinct asset symbols per event so we can answer: all pairs, or only the
 * selected one?
 *
 * IMPORTANT during the run: do NOT switch assets in the browser. We want to
 * know what arrives for a single selected pair. If many symbols show up anyway,
 * the feed is broadcasting everything.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { config, paths } from '../config.js';
import { openPersistentContext, firstPage, dismissPopups } from '../lib/browser.js';
import { redactRawText, redactValue } from '../lib/redact.js';
import { attachCapture } from './capture.js';
import { SpikeAnalyzer } from './analyzer.js';

function ts(): string {
  // Date.now() is fine here (real runtime, not a workflow script).
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function main() {
  if (!fs.existsSync(paths.chromeProfile)) {
    console.error(`No saved profile at ${paths.chromeProfile}.\nRun:  npm run login  first.`);
    process.exit(1);
  }
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.mkdirSync(paths.diagnosticsDir, { recursive: true });

  const stamp = ts();
  const framePath = path.join(paths.logsDir, `frames-${stamp}.jsonl`);
  const reportPath = path.join(paths.diagnosticsDir, `spike-${stamp}.json`);
  const frameStream = fs.createWriteStream(framePath, { flags: 'a' });

  const analyzer = new SpikeAnalyzer();

  const context = await openPersistentContext({ headless: config.headless });
  const page = await firstPage(context);

  const seenSockets = new Set<string>();
  attachCapture(context, (frame, dir, url) => {
    if (!seenSockets.has(url)) { seenSockets.add(url); console.log(`  ↔ WebSocket: ${url}`); }
    if (!frame) { analyzer.markBinary(); return; }
    analyzer.add(frame);
    frameStream.write(JSON.stringify({
      t: new Date().toISOString(),
      dir,
      url,
      engineType: frame.engineType,
      socketType: frame.socketType,
      namespace: frame.namespace,
      event: frame.event,
      args: frame.args ? redactValue(frame.args) : undefined,
      raw: frame.json === undefined ? redactRawText(frame.raw).slice(0, 500) : undefined,
    }) + '\n');
  });

  console.log(`\n→ Opening ${config.poCabinetUrl} with saved session…`);
  await page.goto(config.poCabinetUrl, { waitUntil: 'domcontentloaded' }).catch((e) => {
    console.log(`  (navigation note: ${e.message})`);
  });
  await page.waitForTimeout(2500);
  await dismissPopups(page);

  console.log('\n─────────────────────────────────────────────────────');
  console.log('  RECORDING FEED FRAMES');
  console.log(`  • Log:    ${framePath}`);
  console.log('  • If a promo popup is covering the chart, close it now.');
  console.log('  • Do NOT switch assets — keep one pair selected.');
  console.log('  • A live tally prints every 10s.');
  console.log(`  • Auto-stops after ${Math.round(config.spikeDurationMs / 1000)}s, or press ENTER to stop now.`);
  console.log('─────────────────────────────────────────────────────\n');

  const tally = setInterval(() => {
    console.log(`  … ${analyzer.totalFrames} frames | ${analyzer.events.size} events | ${analyzer.allSymbols.size} symbols`);
  }, 10_000);

  await Promise.race([
    waitForEnter('  [ENTER] to stop early…\n'),
    new Promise<void>((resolve) => setTimeout(resolve, config.spikeDurationMs)),
  ]);

  clearInterval(tally);
  frameStream.end();

  const report = analyzer.toJSON();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('\n' + analyzer.report());
  console.log(`\n  Full report:  ${reportPath}`);
  console.log(`  Raw frames:   ${framePath}\n`);

  await context.close();
}

main().catch((err) => {
  console.error('Spike failed:', err);
  process.exit(1);
});

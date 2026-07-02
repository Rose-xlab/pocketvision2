/**
 * Phase 2 — one pair, end-to-end (validation runner).
 *
 * Reuses the logged-in browser session to receive the live tick feed for the
 * ONE pair you have selected in Pocket Option, builds 1-minute candles, runs
 * the streak engine, and prints every closed candle + the running streak so you
 * can compare it against the live PO chart. Streak alerts are printed to the
 * console here; Telegram delivery is wired next once a bot token is configured.
 *
 * Run:  npm run scan:one   (select the pair you want in the browser first)
 */
import readline from 'node:readline';
import { config } from '../config.js';
import { openPersistentContext, firstPage, dismissPopups } from '../lib/browser.js';
import { attachCapture } from '../phase1/capture.js';
import { CandleBuilder, type Tick, type Candle } from './candles.js';
import { StreakEngine, colourOf } from './streaks.js';
import { TelegramSender, formatAlert } from '../lib/telegram.js';

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

function hhmm(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(11, 19);
}

const DOT = { green: '🟢', red: '🔴', doji: '⚪' } as const;

async function main() {
  const builder = new CandleBuilder(config.timeframeSec, config.graceSec);
  const engine = new StreakEngine({ threshold: config.streakThreshold, breakOnDoji: config.breakOnDoji, minBodyPct: config.minBodyPct });
  const telegram = new TelegramSender(config.telegram.token, config.telegram.chatId);
  const labels = new Map<string, string>(); // symbol → human label from updateAssets

  const context = await openPersistentContext({ headless: config.headless });
  const page = await firstPage(context);

  let liveStarted = false; // ignore history-seeded candles for alerting until live begins

  const onClosedCandle = (candle: Candle, seeded: boolean) => {
    const colour = colourOf(candle);
    const alert = engine.onCandle(candle);
    const st = engine.peek(candle.symbol);
    const streakStr = st?.colour ? `${st.count}× ${st.colour}` : 'flat';
    const tag = seeded ? 'seed ' : 'live ';
    console.log(`  ${tag}${DOT[colour]} ${candle.symbol} ${hhmm(candle.periodStart)}  O:${candle.open} C:${candle.close}  → ${streakStr}`);
    if (alert && !seeded) {
      const msg = formatAlert(alert, config.timeframeSec, labels.get(alert.symbol));
      console.log('  ────────────────────────────────────────────');
      console.log(msg.split('\n').map((l) => `  🚨 ${l}`).join('\n'));
      console.log('  ────────────────────────────────────────────');
      telegram.enqueue(msg);
    }
  };

  attachCapture(context, (frame) => {
    if (!frame?.event) return;

    // Catalog → human labels (entry = [id, symbol, label, type, …]).
    if (frame.event === 'updateAssets') {
      const entries = (frame.args?.[0] as unknown[]) ?? [];
      for (const e of entries) {
        if (Array.isArray(e) && typeof e[1] === 'string' && typeof e[2] === 'string') labels.set(e[1], e[2]);
      }
      return;
    }

    // Seed candles from tick history so we don't wait minutes for context.
    if (frame.event === 'updateHistoryNewFast') {
      const p = frame.args?.[0] as { asset?: string; history?: [number, number][] } | undefined;
      if (p?.asset && Array.isArray(p.history)) {
        for (const [ts, price] of p.history) {
          for (const c of builder.addTick({ symbol: p.asset, ts, price })) onClosedCandle(c, !liveStarted);
        }
      }
      return;
    }

    // Live ticks: updateStream = [[[symbol, ts, price], …]]
    if (frame.event === 'updateStream') {
      const ticks = (frame.args?.[0] as unknown[]) ?? [];
      for (const t of ticks) {
        if (Array.isArray(t) && typeof t[0] === 'string') {
          liveStarted = true;
          const tick: Tick = { symbol: t[0], ts: Number(t[1]), price: Number(t[2]) };
          for (const c of builder.addTick(tick)) onClosedCandle(c, false);
        }
      }
    }
  });

  console.log(`\n→ Opening ${config.poCabinetUrl} …`);
  await page.goto(config.poCabinetUrl, { waitUntil: 'domcontentloaded' }).catch((e) => console.log(`  (nav note: ${e.message})`));
  await page.waitForTimeout(2500);
  await dismissPopups(page);

  console.log('\n─────────────────────────────────────────────────────');
  console.log('  PHASE 2 — LIVE SINGLE-PAIR SCAN');
  console.log(`  • Threshold: ${config.streakThreshold} | timeframe: ${config.timeframeSec}s | doji: ${config.breakOnDoji ? 'break' : 'ignore'}`);
  console.log('  • Select the pair you want in the browser; keep it selected.');
  console.log('  • Compare printed candles (O/C, colour) against the PO chart.');
  console.log(`  • Telegram: ${telegram.isEnabled ? 'ENABLED — alerts will be sent' : 'disabled (console only)'}`);
  console.log('  • Press ENTER to stop.');
  console.log('─────────────────────────────────────────────────────\n');

  // Time-based close for quiet minutes.
  const flusher = setInterval(() => {
    const nowSec = Date.now() / 1000;
    for (const c of builder.flush(nowSec)) onClosedCandle(c, false);
  }, 1000);

  await waitForEnter('');
  clearInterval(flusher);
  await telegram.drain();
  await context.close();
}

main().catch((err) => {
  console.error('Live scan failed:', err);
  process.exit(1);
});

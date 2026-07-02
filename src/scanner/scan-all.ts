/**
 * Phase 3 — multi-pair scanner.
 *
 * Keeps one logged-in browser page, lets PO connect (so we capture its auth
 * frame), then opens one Socket.IO connection per watchlist pair via the in-page
 * feed manager. Every pair's tick stream flows through the same candle builder +
 * streak engine; alerts go to the console and Telegram.
 *
 * Run:  npm run scan   (set WATCHLIST / MAX_PAIRS / STREAK_THRESHOLD in .env)
 */
import readline from 'node:readline';
import { config, paths } from '../config.js';
import { openPersistentContext, firstPage, dismissPopups } from '../lib/browser.js';
import { attachCapture } from '../phase1/capture.js';
import { CandleBuilder, type Tick, type Candle } from './candles.js';
import { StreakEngine } from './streaks.js';
import { TelegramSender, formatAlert } from '../lib/telegram.js';
import { SupabaseSink } from '../lib/supabase.js';
import { installFeed } from './feed-inject.js';
import { OutcomeTracker } from './outcomes.js';

/** Resolves on ENTER (interactive) or SIGINT/SIGTERM (Ctrl+C, systemd stop). */
function waitForStop(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const done = () => { rl.close(); resolve(); };
    rl.question('', done);
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}
const hhmm = (s: number) => new Date(s * 1000).toISOString().slice(11, 19);
const DOT = { green: '🟢', red: '🔴', doji: '⚪' } as const;

interface FeedStatus { conns: number; live: number; authReady: boolean }

async function main() {
  const builder = new CandleBuilder(config.timeframeSec, config.graceSec);
  const engine = new StreakEngine({ threshold: config.streakThreshold, breakOnDoji: config.breakOnDoji, minBodyPct: config.minBodyPct });
  const telegram = new TelegramSender(config.telegram.token, config.telegram.chatId);
  const supabase = new SupabaseSink(config.supabase.url, config.supabase.serviceKey);
  const labels = new Map<string, string>();
  const catalog = new Map<string, { isOpen: boolean; otc: boolean; payout: number; type: string }>();
  const liveSymbols = new Set<string>();
  const tracker = new OutcomeTracker(paths.outcomesFile);
  let alertCount = 0;
  let lastTickAt = Date.now();

  const context = await openPersistentContext({ headless: config.headless });
  await context.addInitScript(installFeed);
  const page = await firstPage(context);

  // In-page feed calls, hardened against transient navigation/reload errors.
  const feedStatus = () =>
    page.evaluate(() => (window as unknown as { __feedStatus?: () => FeedStatus }).__feedStatus?.()).catch(() => undefined);
  const feedAdd = (syms: string[]) =>
    page.evaluate((s) => (window as unknown as { __feedAdd?: (x: string[]) => number }).__feedAdd?.(s) ?? 0, syms).catch(() => 0);
  const feedRemove = (syms: string[]) =>
    page.evaluate((s) => (window as unknown as { __feedRemove?: (x: string[]) => number }).__feedRemove?.(s) ?? 0, syms).catch(() => 0);

  const onClosedCandle = (candle: Candle) => {
    // Settle any pending alert outcome BEFORE the engine can register a new one.
    const outcome = tracker.onCandle(candle);
    if (outcome) {
      console.log(`  📊 ${outcome.symbol}: ${outcome.outcome} after ${outcome.streak} ${outcome.colour} | ${tracker.summary()}`);
      supabase.outcome(outcome);
    }

    const seeded = !liveSymbols.has(candle.symbol);
    const alert = engine.onCandle(candle);
    if (alert && !seeded) {
      // Payouts drift during the session; suppress alerts for pairs that have
      // slipped below the floor since the watchlist was built.
      const meta = catalog.get(alert.symbol);
      if (meta && meta.payout < config.minPayout) {
        console.log(`  (alert for ${alert.symbol} suppressed: payout ${meta.payout}% < ${config.minPayout}%)`);
        return;
      }
      alertCount++;
      const msg = formatAlert(alert, config.timeframeSec, labels.get(alert.symbol), meta?.payout);
      console.log('\n  ────────────────────────────────────────────');
      console.log(msg.split('\n').map((l) => `  🚨 ${l}`).join('\n'));
      console.log('  ────────────────────────────────────────────\n');
      telegram.enqueue(msg);
      tracker.register(alert, { payout: meta?.payout, label: labels.get(alert.symbol) });
      supabase.alert(alert, { payout: meta?.payout, label: labels.get(alert.symbol) }, config.timeframeSec);
    }
  };

  attachCapture(context, (frame) => {
    if (!frame?.event) return;
    if (frame.event === 'updateAssets') {
      for (const e of (frame.args?.[0] as unknown[]) ?? []) {
        if (Array.isArray(e) && typeof e[1] === 'string') {
          // Asset row: [1]=symbol [2]=label [3]=class [5]=payout% [14]=isOpen
          catalog.set(e[1], {
            isOpen: e[14] === true,
            otc: /_otc$/i.test(e[1]),
            payout: typeof e[5] === 'number' ? e[5] : 0,
            type: typeof e[3] === 'string' ? e[3] : 'unknown',
          });
          if (typeof e[2] === 'string') labels.set(e[1], e[2]);
        }
      }
      return;
    }
    if (frame.event === 'updateHistoryNewFast') {
      const p = frame.args?.[0] as { asset?: string; history?: [number, number][] } | undefined;
      if (p?.asset && Array.isArray(p.history)) {
        for (const [ts, price] of p.history) for (const c of builder.addTick({ symbol: p.asset, ts, price })) onClosedCandle(c);
      }
      return;
    }
    if (frame.event === 'updateStream') {
      for (const t of (frame.args?.[0] as unknown[]) ?? []) {
        if (Array.isArray(t) && typeof t[0] === 'string') {
          const tick: Tick = { symbol: t[0], ts: Number(t[1]), price: Number(t[2]) };
          lastTickAt = Date.now();
          liveSymbols.add(tick.symbol);
          for (const c of builder.addTick(tick)) onClosedCandle(c);
        }
      }
    }
  });

  console.log(`\n→ Opening ${config.poCabinetUrl} …`);
  await page.goto(config.poCabinetUrl, { waitUntil: 'domcontentloaded' }).catch((e) => console.log(`  (nav note: ${e.message})`));
  await page.waitForTimeout(2500);
  await dismissPopups(page);

  // Wait until PO's auth frame + catalog are ready.
  console.log('  Waiting for session + asset catalog…');
  for (let i = 0; i < 60; i++) {
    const st = await feedStatus();
    if (st?.authReady && catalog.size > 0) break;
    await page.waitForTimeout(1000);
  }
  if (catalog.size === 0) {
    const st = await feedStatus();
    console.error('! No asset catalog received after 60s.');
    if (st?.authReady) {
      console.error('  Login/auth is fine, but PO\'s market-data servers are not responding');
      console.error('  (terminal stuck on its loading screen). This is server-side — usually a');
      console.error('  temporary throttle. Wait 30–60 minutes and try again.');
    } else {
      console.error('  No auth frame was captured — the session may have expired.');
      console.error('  Run:  npm run login   to sign in again.');
    }
    await context.close();
    process.exit(1);
  }

  // Eligible assets right now: open, payout ≥ floor, best payout first.
  const buildAutoWatchlist = () =>
    [...catalog.entries()]
      .filter(([, m]) => m.isOpen && m.payout >= config.minPayout)
      .sort((a, b) => (b[1].payout - a[1].payout) || (Number(b[1].otc) - Number(a[1].otc))) // OTC breaks ties
      .map(([sym]) => sym)
      .slice(0, config.maxPairs);

  let watchlist: string[] = config.watchlist !== 'auto'
    ? config.watchlist.split(',').map((s) => s.trim()).filter(Boolean)
    : buildAutoWatchlist();

  const byClass = new Map<string, number>();
  for (const sym of watchlist) {
    const t = catalog.get(sym)?.type ?? 'unknown';
    byClass.set(t, (byClass.get(t) ?? 0) + 1);
  }
  const classSummary = [...byClass.entries()].map(([t, n]) => `${t} ${n}`).join(', ');

  console.log('\n─────────────────────────────────────────────────────');
  console.log('  PHASE 3 — MULTI-PAIR SCAN');
  console.log(`  • Threshold: ${config.streakThreshold} | timeframe: ${config.timeframeSec}s | doji: ${config.breakOnDoji ? 'break' : 'ignore'}`);
  console.log(`  • Payout floor: ${config.minPayout}%`);
  console.log(`  • Watchlist: ${watchlist.length} pairs (catalog ${catalog.size}, cap ${config.maxPairs}) — ${classSummary || 'n/a'}`);
  console.log(`  • Telegram: ${telegram.isEnabled ? 'ENABLED' : 'disabled (console only)'}`);
  console.log(`  • Supabase: ${supabase.isEnabled ? 'ENABLED' : 'disabled (local log only)'}`);
  console.log('  • Press ENTER (or send SIGTERM) to stop.');
  console.log('─────────────────────────────────────────────────────\n');

  const opened = await feedAdd(watchlist);
  console.log(`  Opening ${opened} connections (staggered)…`);

  const flusher = setInterval(() => {
    for (const c of builder.flush(Date.now() / 1000)) onClosedCandle(c);
  }, 1000);

  const status = setInterval(async () => {
    const st = await feedStatus();
    const active = watchlist
      .map((s) => ({ s, p: engine.peek(s) }))
      .filter((x) => x.p && x.p.count >= 2 && x.p.colour)
      .sort((a, b) => (b.p!.count) - (a.p!.count))
      .slice(0, 6)
      .map((x) => `${x.s.replace(/_otc$/, '')} ${x.p!.count}${x.p!.colour === 'red' ? '🔴' : '🟢'}`);
    console.log(`  [status] conns ${st?.live ?? '?'}/${st?.conns ?? '?'} live | candles for ${liveSymbols.size} pairs | alerts ${alertCount} | top: ${active.join('  ') || '—'}`);
  }, 15_000);

  // ── Watchdog (#4): a silent feed is never ambiguous — warn, then self-heal. ──
  let feedStale = false;
  let recovering = false;
  let lastRecoveryAt = 0;
  const watchdog = setInterval(async () => {
    const silentSec = (Date.now() - lastTickAt) / 1000;
    if (!feedStale && silentSec > config.staleFeedSec) {
      feedStale = true;
      const msg = `⚠️ PocketVision: no ticks for ${Math.round(silentSec)}s — feed looks dead, attempting recovery.`;
      console.warn(`\n  ${msg}\n`);
      void telegram.send(msg);
    } else if (feedStale && silentSec < config.staleFeedSec) {
      feedStale = false;
      const msg = '✅ PocketVision: feed recovered — ticks are flowing again.';
      console.log(`\n  ${msg}\n`);
      void telegram.send(msg);
    }
    if (feedStale && !recovering && Date.now() - lastRecoveryAt > 90_000) {
      recovering = true;
      lastRecoveryAt = Date.now();
      try {
        console.log('  [watchdog] reloading terminal + reopening connections…');
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(2500);
        await dismissPopups(page);
        for (let i = 0; i < 30; i++) {
          if ((await feedStatus())?.authReady) break;
          await page.waitForTimeout(1000);
        }
        const reopened = await feedAdd(watchlist);
        console.log(`  [watchdog] reopened ${reopened} connections`);
      } finally {
        recovering = false;
      }
    }
  }, 15_000);

  // ── Heartbeat (#4): silence from the bot ≠ silence from the market. ──
  const startedAt = Date.now();
  const heartbeat = config.heartbeatMin > 0
    ? setInterval(async () => {
        const st = await feedStatus();
        const hours = ((Date.now() - startedAt) / 3_600_000).toFixed(1);
        telegram.enqueue(`💓 PocketVision alive ${hours}h | conns ${st?.live ?? '?'}/${st?.conns ?? '?'} | pairs ${watchlist.length} | alerts ${alertCount} | ${tracker.summary()}`);
        supabase.heartbeat({ connsLive: st?.live, connsTotal: st?.conns, pairs: watchlist.length, alerts: alertCount, summary: tracker.summary() });
      }, config.heartbeatMin * 60_000)
    : null;

  // ── Dynamic watchlist (#3): follow payouts + market hours all session. ──
  const refresher = config.watchlist === 'auto' && config.watchlistRefreshMin > 0
    ? setInterval(async () => {
        const desired = buildAutoWatchlist();
        const current = new Set(watchlist);
        const wanted = new Set(desired);
        const toAdd = desired.filter((s) => !current.has(s));
        const toRemove = watchlist.filter((s) => !wanted.has(s));
        if (toAdd.length === 0 && toRemove.length === 0) return;
        await feedRemove(toRemove);
        await feedAdd(toAdd);
        watchlist = desired;
        const fmt = (l: string[]) => l.slice(0, 6).join(', ') + (l.length > 6 ? ', …' : '');
        console.log(`  [watchlist] refreshed → ${watchlist.length} pairs${toAdd.length ? ` | +${toAdd.length}: ${fmt(toAdd)}` : ''}${toRemove.length ? ` | −${toRemove.length}: ${fmt(toRemove)}` : ''}`);
      }, config.watchlistRefreshMin * 60_000)
    : null;

  await waitForStop();
  clearInterval(flusher);
  clearInterval(status);
  clearInterval(watchdog);
  if (heartbeat) clearInterval(heartbeat);
  if (refresher) clearInterval(refresher);
  console.log(`\n  Session summary: ${alertCount} alerts | ${tracker.summary()}`);
  console.log(`  Outcome log: ${paths.outcomesFile}  (analyse with: npm run report)`);
  await telegram.drain();
  await context.close();
}

main().catch((err) => { console.error('Scan failed:', err); process.exit(1); });

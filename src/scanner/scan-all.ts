/**
 * Phase 3 — multi-pair scanner (rotating-pool architecture).
 *
 * Keeps one logged-in browser page, lets PO connect (so we capture its auth
 * frame), then opens a SMALL persistent socket pool via the in-page feed
 * manager. Each socket rotates across the watchlist with `changeSymbol`; every
 * visit pulls a 7–10 min history backfill, so streak tracking is gapless for
 * the WHOLE watchlist with only ~6 connections (PO's per-IP ceiling is ~8).
 * Pairs whose streak nears the threshold are PINNED to a socket and stream
 * live, so the alerting candle is always seen in real time.
 *
 * Run:  npm run scan   (set MAX_PAIRS / FEED_POOL / DWELL_SEC etc. in .env)
 */
import readline from 'node:readline';
import { config, paths } from '../config.js';
import { openPersistentContext, firstPage, dismissPopups } from '../lib/browser.js';
import { attachCapture } from '../phase1/capture.js';
import { CandleBuilder, type Tick, type Candle } from './candles.js';
import { StreakEngine } from './streaks.js';
import { TelegramSender, formatAlert, type TradeAdvice } from '../lib/telegram.js';
import { SupabaseSink } from '../lib/supabase.js';
import { installFeed } from './feed-inject.js';
import { OutcomeTracker, type OutcomeRecord } from './outcomes.js';
import { EdgeBook, classifyAsset } from './edge.js';
import { RiskManager } from '../risk/manager.js';

/**
 * Resolves on ENTER (interactive) or SIGINT/SIGTERM (Ctrl+C, systemd stop).
 * Service mode (PV_SERVICE=1, set by the VPS scheduled task): never resolves —
 * there is no interactive stop, and an accidental Ctrl+C in the console kills
 * the process with a NONZERO exit so the task's restart-on-failure revives it.
 */
function waitForStop(): Promise<void> {
  if ((process.env.PV_SERVICE ?? '').trim() === '1') return new Promise(() => { /* run until killed */ });
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

interface FeedStatus { conns: number; live: number; authReady: boolean; paused: boolean; pinned: string[]; watchlist: number }

async function main() {
  const builder = new CandleBuilder(config.timeframeSec, config.graceSec);
  const engine = new StreakEngine({ threshold: config.streakThreshold, breakOnDoji: config.breakOnDoji, minBodyPct: config.minBodyPct });
  const telegram = new TelegramSender(config.telegram.token, config.telegram.chatId);
  const supabase = new SupabaseSink(config.supabase.url, config.supabase.serviceKey);
  const labels = new Map<string, string>();
  const catalog = new Map<string, { isOpen: boolean; otc: boolean; payout: number; type: string }>();
  const tracker = new OutcomeTracker(paths.outcomesFile, undefined, config.realEntryDelaySec);
  // Seed the edge book from the full outcome history, then keep it current —
  // every alert is stamped with the measured edge for its asset class.
  const edgeBook = new EdgeBook(paths.outcomesFile);
  // Risk manager: the bot still never places PO trades itself — but every
  // GRADUATED alert now carries the exact stake the maths allows, and the
  // decay/kill logic stops advising size the moment the edge stops being real.
  const risk = new RiskManager(config.risk, paths.riskStateFile);
  let alertCount = 0;
  let lastTickAt = Date.now();

  const adviceFor = (symbol: string): TradeAdvice => {
    const cls = classifyAsset(catalog.get(symbol)?.type, labels.get(symbol), symbol);
    const s = edgeBook.rideStats(cls);
    const pf = (x: number) => `${(x * 100).toFixed(1)}%`;
    const stats = `${cls} ride: ${pf(s.winRate)} win (n=${s.n}, CI ${pf(s.ci[0])}–${pf(s.ci[1])}), EV ${s.ev >= 0 ? '+' : ''}${pf(s.ev)}`;
    if (s.decayed) return { action: 'OBSERVE', note: `${stats} — ⚠️ DECAYED (rolling window below break-even), demoted to paper` };
    if (s.status === 'GRADUATED') {
      const d = risk.stakeFor(`po-ride-${cls}`, s);
      const sizing = d.allowed
        ? `Stake: ${d.stakePct}% of bankroll${d.stake > 0 ? ` = ${d.stake}` : ''} (${d.reason})`
        : `NO STAKE — ${d.reason}`;
      return { action: 'RIDE', note: `${stats} — VALIDATED ✅ | ${sizing}` };
    }
    if (s.status === 'candidate') return { action: 'RIDE', note: `${stats} — PAPER ONLY (not yet validated)` };
    if (s.status === 'insufficient') return { action: 'OBSERVE', note: `${stats} — not enough data yet` };
    return { action: 'OBSERVE', note: `no positive edge measured — ${stats}` };
  };

  const handleOutcome = (o: OutcomeRecord) => {
    const verdict = o.outcome === 'continuation' ? 'ride WIN ✅' : o.outcome === 'reversal' ? 'ride LOSS ❌' : o.outcome;
    console.log(`  📊 ${o.symbol}: ${verdict} after ${o.streak} ${o.colour} | ${tracker.summary()}`);
    supabase.outcome(o);
    edgeBook.add(o);
    // Decay monitor: one-shot Telegram alarm on ok→decayed (and recovery).
    const alarm = edgeBook.decayAlarm(classifyAsset(o.assetType, o.label, o.symbol));
    if (alarm) { console.warn(`\n  ${alarm}\n`); void telegram.send(alarm); }
  };

  // Per-symbol tick watermark: rotation revisits re-send overlapping history,
  // so every tick at or below the watermark has already been counted.
  const lastTs = new Map<string, number>();
  // Wall-clock ms of the last LIVE (updateStream) tick per symbol — decides
  // whether a symbol's candles close on the fast grace or wait for backfill.
  const lastLiveAt = new Map<string, number>();

  // PO feed timestamps are platform time on SOME servers (+2h observed on the
  // VPS) and true UTC on others — normalize to true UTC at the door so
  // candles, alerts, freshness gates and timeouts all agree with the real
  // clock. Starts from config and self-corrects from measured live-tick skew.
  let poOffsetSec = config.poTimeOffsetHours * 3600;

  // Future-tick guard: a tick stamped >10 min ahead of the system clock means
  // the offset config is wrong for THIS environment (PO serves +2h platform
  // time on some servers, true UTC on others). Ingesting it would poison the
  // per-symbol watermark for hours and let stale backfill candles fire fresh-
  // looking alerts — drop it and say why, once.
  let futureWarned = false;
  const ingest = (symbol: string, rawTs: number, price: number) => {
    if (!Number.isFinite(rawTs) || !Number.isFinite(price)) return;
    const ts = rawTs - poOffsetSec;
    if (ts > Date.now() / 1000 + 600) {
      if (!futureWarned) {
        futureWarned = true;
        const skewH = ((rawTs - Date.now() / 1000) / 3600).toFixed(1);
        const msg = `⚠️ PocketVision: feed ticks are ~${skewH}h ahead of the clock but PO_TIME_OFFSET_HOURS=${config.poTimeOffsetHours}. ` +
          `Dropping future ticks. Set PO_TIME_OFFSET_HOURS=${Math.round((rawTs - Date.now() / 1000) / 3600)} in .env and restart.`;
        console.warn(`\n  ${msg}\n`);
        void telegram.send(msg);
      }
      return;
    }
    if (ts <= (lastTs.get(symbol) ?? 0)) return;
    lastTs.set(symbol, ts);
    // Realistic-entry capture: first tick ≥ delay into a pending alert's entry candle.
    tracker.onTick(symbol, ts, price);
    for (const c of builder.addTick({ symbol, ts, price })) onClosedCandle(c);
  };

  // Self-correction: live ticks are created "now", so their raw skew vs the
  // system clock IS this environment's true offset. After 30 samples, if the
  // median disagrees with the configured value by more than 30 min, adopt the
  // measured offset (whole hours) for the rest of the session — the future-
  // tick guard has been dropping the mis-stamped ticks in the meantime, so
  // nothing was poisoned. One-shot, announced, and .env can persist it.
  const skewSamples: number[] = [];
  let skewHandled = false;
  const checkSkew = (rawTs: number) => {
    if (skewHandled) return;
    skewSamples.push(rawTs - Date.now() / 1000);
    if (skewSamples.length < 30) return;
    skewHandled = true;
    const median = [...skewSamples].sort((a, b) => a - b)[15]!;
    if (Math.abs(median - poOffsetSec) > 1800) {
      const hours = Math.round(median / 3600);
      poOffsetSec = hours * 3600;
      const msg = `🕐 PocketVision: this feed's clock is ${(median / 3600).toFixed(1)}h ahead of UTC — ` +
        `auto-adjusted for this session. Set PO_TIME_OFFSET_HOURS=${hours} in .env to make it permanent.`;
      console.warn(`\n  ${msg}\n`);
      void telegram.send(msg);
    }
  };

  const context = await openPersistentContext({ headless: config.headless });
  await context.addInitScript(installFeed);
  const page = await firstPage(context);

  // In-page feed calls, hardened against transient navigation/reload errors.
  const feedStatus = () =>
    page.evaluate(() => (window as unknown as { __feedStatus?: () => FeedStatus }).__feedStatus?.()).catch(() => undefined);
  const feedStart = (syms: string[]) =>
    page.evaluate(
      ({ s, pool, dwell }) => (window as unknown as { __feedStart?: (x: string[], p: number, d: number) => number }).__feedStart?.(s, pool, dwell) ?? 0,
      { s: syms, pool: config.feedPool, dwell: config.dwellSec },
    ).catch(() => 0);
  const feedSetWatchlist = (syms: string[]) =>
    page.evaluate((s) => (window as unknown as { __feedSetWatchlist?: (x: string[]) => number }).__feedSetWatchlist?.(s) ?? 0, syms).catch(() => 0);
  const feedPin = (sym: string) =>
    page.evaluate((s) => (window as unknown as { __feedPin?: (x: string) => boolean }).__feedPin?.(s) ?? false, sym).catch(() => false);
  const feedUnpin = (sym: string) =>
    page.evaluate((s) => (window as unknown as { __feedUnpin?: (x: string) => boolean }).__feedUnpin?.(s) ?? false, sym).catch(() => false);

  // ── Pin driver: hot pairs (streak within pinMargin of threshold) get a
  // dedicated live socket so the alerting candle streams in real time. ──
  const PIN_MARGIN = config.pinMargin;
  const maxPins = Math.max(1, config.feedPool - 2); // always keep ≥2 rotating
  // Alert freshness ceiling — recomputed from the real sweep once the
  // watchlist is known (a backfill-detected alert is at most one sweep old).
  let alertFreshnessSec = 150;
  const pinned = new Set<string>();
  const countOf = (sym: string) => {
    const st = engine.peek(sym);
    return st?.colour ? st.count : 0;
  };
  const updatePin = (symbol: string) => {
    const hot = countOf(symbol) >= config.streakThreshold - PIN_MARGIN;
    if (hot && !pinned.has(symbol)) {
      if (pinned.size >= maxPins) {
        // Evict the coolest pin only if this candidate is strictly hotter.
        let coolest: string | undefined;
        for (const p of pinned) if (coolest === undefined || countOf(p) < countOf(coolest)) coolest = p;
        if (coolest === undefined || countOf(coolest) >= countOf(symbol)) return;
        pinned.delete(coolest);
        void feedUnpin(coolest);
        console.log(`  [pin] ${coolest.replace(/_otc$/, '')} evicted for hotter ${symbol.replace(/_otc$/, '')}`);
      }
      pinned.add(symbol);
      void feedPin(symbol);
      console.log(`  [pin] ${symbol.replace(/_otc$/, '')} at ${countOf(symbol)} — live socket until streak breaks`);
    } else if (!hot && pinned.has(symbol)) {
      pinned.delete(symbol);
      void feedUnpin(symbol);
    }
  };

  const onClosedCandle = (candle: Candle) => {
    // Settle any pending alert outcomes BEFORE the engine can register new ones.
    for (const o of tracker.onCandle(candle)) handleOutcome(o);

    // Freshness gate: candles older than one sweep (+margin) are seeded
    // history (startup backfill) — track their streak state but never alert
    // on them. A normal sweep-revisit candle is at most one sweep old.
    const closedAgoSec = Date.now() / 1000 - (candle.periodStart + candle.timeframeSec);
    const alert = engine.onCandle(candle);
    updatePin(candle.symbol);
    if (alert && closedAgoSec <= alertFreshnessSec) {
      // Payouts drift during the session; suppress alerts for pairs that have
      // slipped below the floor since the watchlist was built.
      const meta = catalog.get(alert.symbol);
      if (meta && meta.payout < config.minPayout) {
        console.log(`  (alert for ${alert.symbol} suppressed: payout ${meta.payout}% < ${config.minPayout}%)`);
        return;
      }
      alertCount++;
      const msg = formatAlert(alert, config.timeframeSec, labels.get(alert.symbol), meta?.payout, adviceFor(alert.symbol));
      console.log('\n  ────────────────────────────────────────────');
      console.log(msg.split('\n').map((l) => `  🚨 ${l}`).join('\n'));
      console.log('  ────────────────────────────────────────────\n');
      telegram.enqueue(msg);
      tracker.register(alert, { payout: meta?.payout, label: labels.get(alert.symbol), assetType: meta?.type });
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
        lastTickAt = Date.now(); // backfill counts as feed activity
        for (const [ts, price] of p.history) ingest(p.asset, ts, price);
      }
      return;
    }
    if (frame.event === 'updateStream') {
      for (const t of (frame.args?.[0] as unknown[]) ?? []) {
        if (Array.isArray(t) && typeof t[0] === 'string') {
          const tick: Tick = { symbol: t[0], ts: Number(t[1]), price: Number(t[2]) };
          lastTickAt = Date.now();
          lastLiveAt.set(tick.symbol, Date.now());
          checkSkew(tick.ts);
          ingest(tick.symbol, tick.ts, tick.price);
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

  const sweepSec = () => Math.ceil(watchlist.length / config.feedPool) * config.dwellSec;

  console.log('\n─────────────────────────────────────────────────────');
  console.log('  PHASE 3 — MULTI-PAIR SCAN (rotating pool)');
  console.log(`  • Threshold: ${config.streakThreshold} | timeframe: ${config.timeframeSec}s | doji: ${config.breakOnDoji ? 'break' : 'ignore'}`);
  console.log(`  • Payout floor: ${config.minPayout}%`);
  console.log(`  • Watchlist: ${watchlist.length} pairs (catalog ${catalog.size}, cap ${config.maxPairs}) — ${classSummary || 'n/a'}`);
  console.log(`  • Pool: ${config.feedPool} sockets | dwell ${config.dwellSec}s | full sweep ≈ ${sweepSec()}s`);
  console.log(`  • Telegram: ${telegram.isEnabled ? 'ENABLED' : 'disabled (console only)'}`);
  console.log(`  • Supabase: ${supabase.isEnabled ? 'ENABLED' : 'disabled (local log only)'}`);
  console.log('  • Press ENTER (or send SIGTERM) to stop.');
  console.log('─────────────────────────────────────────────────────\n');

  // Pinning at threshold−N needs every pair visited at least once per N
  // candles, or a streak could hit the threshold before we notice it's hot.
  if (sweepSec() > config.timeframeSec * PIN_MARGIN - 10) {
    console.warn(`  ⚠ Sweep (${sweepSec()}s) exceeds ${PIN_MARGIN} candles — raise FEED_POOL/PIN_MARGIN or lower DWELL_SEC/MAX_PAIRS to guarantee real-time alerts.`);
  }
  alertFreshnessSec = Math.max(150, sweepSec() + 60);

  const started = await feedStart(watchlist);
  console.log(`  Rotating ${started} pairs over ${config.feedPool} sockets…`);
  // Pins requested before the pool existed (candles close during the catalog
  // wait, off PO's own chart stream) were recorded node-side only — re-assert.
  for (const s of pinned) void feedPin(s);

  // Live pairs close on the normal grace; rotated pairs wait for the next
  // visit's backfill to complete the candle (data-driven close). The long
  // grace is only a safety net for pairs the rotation failed to revisit.
  const graceFor = (symbol: string) => {
    const liveRecently = Date.now() - (lastLiveAt.get(symbol) ?? 0) < 8_000;
    return liveRecently ? config.graceSec : Math.max(150, sweepSec() * 2 + 30);
  };
  const flusher = setInterval(() => {
    const now = Date.now() / 1000;
    for (const c of builder.flush(now, graceFor)) onClosedCandle(c);
    // Time out alert outcomes whose post-alert candles never arrived.
    for (const o of tracker.tick(now)) handleOutcome(o);
  }, 1000);

  const status = setInterval(async () => {
    const st = await feedStatus();
    const active = watchlist
      .map((s) => ({ s, p: engine.peek(s) }))
      .filter((x) => x.p && x.p.count >= 2 && x.p.colour)
      .sort((a, b) => (b.p!.count) - (a.p!.count))
      .slice(0, 6)
      .map((x) => `${x.s.replace(/_otc$/, '')} ${x.p!.count}${x.p!.colour === 'red' ? '🔴' : '🟢'}`);
    const pins = st?.pinned?.length ? ` | 📌 ${st.pinned.map((p) => p.replace(/_otc$/, '')).join(',')}` : '';
    console.log(`  [status] conns ${st?.live ?? '?'}/${st?.conns ?? '?'} live${st?.paused ? ' | ⏸ breaker: reconnects paused' : ''}${pins} | tracking ${lastTs.size} pairs | alerts ${alertCount} | top: ${active.join('  ') || '—'}`);
  }, 15_000);

  // ── Watchdog (#4): a silent feed is never ambiguous — warn, then self-heal. ──
  let feedStale = false;
  let recovering = false;
  let lastRecoveryAt = 0;
  let recoveryDelayMs = 90_000;
  const watchdog = setInterval(async () => {
    const silentSec = (Date.now() - lastTickAt) / 1000;
    if (!feedStale && silentSec > config.staleFeedSec) {
      feedStale = true;
      const msg = `⚠️ PocketVision: no ticks for ${Math.round(silentSec)}s — feed looks dead, attempting recovery.`;
      console.warn(`\n  ${msg}\n`);
      void telegram.send(msg);
    } else if (feedStale && silentSec < config.staleFeedSec) {
      feedStale = false;
      recoveryDelayMs = 90_000; // healthy again → next incident starts fresh
      const msg = '✅ PocketVision: feed recovered — ticks are flowing again.';
      console.log(`\n  ${msg}\n`);
      void telegram.send(msg);
    }
    if (feedStale && !recovering && Date.now() - lastRecoveryAt > recoveryDelayMs) {
      recovering = true;
      lastRecoveryAt = Date.now();
      // Each reload+reopen is itself a ~30-connection burst; repeating it
      // every 90s during a server-side throttle extends the punishment.
      recoveryDelayMs = Math.min(recoveryDelayMs * 2, 900_000);
      try {
        console.log('  [watchdog] reloading terminal + reopening connections…');
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(2500);
        await dismissPopups(page);
        for (let i = 0; i < 30; i++) {
          if ((await feedStatus())?.authReady) break;
          await page.waitForTimeout(1000);
        }
        // The reload wiped the in-page manager (init script re-ran fresh), so
        // restart the pool; node-side pins re-assert as candles close.
        pinned.clear();
        const reopened = await feedStart(watchlist);
        console.log(`  [watchdog] restarted pool for ${reopened} pairs (next attempt in ${Math.round(recoveryDelayMs / 60_000)}m if still silent)`);
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
        await feedSetWatchlist(desired);
        for (const s of toRemove) pinned.delete(s); // in-page pins already cleared
        watchlist = desired;
        alertFreshnessSec = Math.max(150, sweepSec() + 60);
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

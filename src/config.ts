import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (one level up from src/). */
export const ROOT = path.resolve(__dirname, '..');

export const paths = {
  /** Persistent Chrome profile (cookies/localStorage/etc.) — log in once, reuse. Gitignored. */
  chromeProfile: path.join(ROOT, '.auth', 'chrome-profile'),
  authDir: path.join(ROOT, '.auth'),
  /** Raw (redacted) WebSocket frame captures from the spike. */
  logsDir: path.join(ROOT, 'logs'),
  /** Human-readable spike summaries / diagnostic reports. */
  diagnosticsDir: path.join(ROOT, 'diagnostics'),
  /** Alert outcome log (JSONL, one record per resolved alert). */
  outcomesFile: path.join(ROOT, 'logs', 'outcomes.jsonl'),
  /** Crypto paper-scan outcome log (Binance venue, same record format). */
  outcomesCryptoFile: path.join(ROOT, 'logs', 'outcomes-crypto.jsonl'),
  /** Funding-rate harvester journal (JSONL: open/mark/close events). */
  fundingFile: path.join(ROOT, 'logs', 'funding.jsonl'),
  /** Risk manager persistent state (equity, day PnL, kill switch). */
  riskStateFile: path.join(ROOT, 'logs', 'risk-state.json'),
};

export const config = {
  poBaseUrl: process.env.PO_BASE_URL ?? 'https://pocketoption.com/en/login',
  poCabinetUrl: process.env.PO_CABINET_URL ?? 'https://pocketoption.com/en/cabinet',
  headless: (process.env.HEADLESS ?? 'false').toLowerCase() === 'true',
  spikeDurationMs: Number(process.env.SPIKE_DURATION_MS ?? 180_000),

  // ── Streak detection ──
  streakThreshold: Number(process.env.STREAK_THRESHOLD ?? 7),
  timeframeSec: Number(process.env.TIMEFRAME_SEC ?? 60),
  graceSec: Number(process.env.GRACE_SEC ?? 1.5),
  breakOnDoji: (process.env.BREAK_ON_DOJI ?? 'true').toLowerCase() === 'true',
  /** Min candle body as % of the asset's recent avg range to count as green/red (0 = off). */
  minBodyPct: Number(process.env.MIN_BODY_PCT ?? 10),

  // ── Telegram ──
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
  },

  // ── Supabase (Phase 4 persistence; service key = VPS scanner ONLY) ──
  supabase: {
    url: (process.env.SUPABASE_URL ?? '').replace(/\/+$/, ''),
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  },

  // ── Multi-pair scan (Phase 3) ──
  /** 'auto' = all open OTC pairs (capped by maxPairs), or a comma list of symbols. */
  watchlist: process.env.WATCHLIST ?? 'auto',
  /** Safety cap on the watchlist size (rotation makes this cheap — not a socket count). */
  maxPairs: Number(process.env.MAX_PAIRS ?? 60),
  /** Only auto-track assets whose payout (%) is at least this. */
  minPayout: Number(process.env.MIN_PAYOUT ?? 87),
  /** Persistent socket pool size — stay under PO's per-IP ceiling (~8 observed). */
  feedPool: Number(process.env.FEED_POOL ?? 6),
  /** Seconds each rotating socket dwells on a pair before moving on. */
  dwellSec: Number(process.env.DWELL_SEC ?? 12),
  /** Pin a pair to a live socket when its streak reaches threshold − this.
   *  Larger margin = earlier pinning = a slower sweep stays safe. */
  pinMargin: Number(process.env.PIN_MARGIN ?? 2),

  // ── Reliability (Phase 3 hardening) ──
  /** No ticks for this many seconds → feed is stale: warn + auto-recover. */
  staleFeedSec: Number(process.env.STALE_FEED_SEC ?? 60),
  /** Telegram "I'm alive" heartbeat interval, minutes (0 = off). */
  heartbeatMin: Number(process.env.HEARTBEAT_MIN ?? 60),
  /** Rebuild the auto-watchlist this often, minutes (0 = off). */
  watchlistRefreshMin: Number(process.env.WATCHLIST_REFRESH_MIN ?? 10),

  /**
   * PO feed clock offset, hours, PER ENVIRONMENT. Verified 2026-07-06: the
   * same account gets true-UTC timestamps on one machine and +2h (platform
   * time) on another (VPS/PO-server dependent). Default 0; the scanner
   * measures the real skew from live ticks at startup and tells you exactly
   * what to set here if it disagrees. Ingestion subtracts this many hours.
   */
  poTimeOffsetHours: Number(process.env.PO_TIME_OFFSET_HOURS ?? 0),

  // ── Realistic entry (Phase 1 hardening) ──
  /** Seconds after the entry candle opens at which a human/delayed executor
   *  realistically gets filled — logged as entryReal on every outcome. */
  realEntryDelaySec: Number(process.env.REAL_ENTRY_DELAY_SEC ?? 10),

  // ── Risk manager (Phase 2) — gates every real-money stake. ──
  risk: {
    /** Total bankroll in account currency (0 = paper everywhere, stakes shown as % only). */
    bankroll: Number(process.env.BANKROLL ?? 0),
    /** Fraction of full Kelly to stake (0.25 = quarter-Kelly, the pro norm). */
    kellyFraction: Number(process.env.KELLY_FRACTION ?? 0.25),
    /** Hard ceiling on any single stake, % of bankroll. */
    maxStakePct: Number(process.env.MAX_STAKE_PCT ?? 2),
    /** Stop trading for the (UTC) day after losing this % of bankroll. */
    dailyStopPct: Number(process.env.DAILY_STOP_PCT ?? 5),
    /** Kill switch: drawdown from equity peak that demotes ALL trading to paper. */
    maxDrawdownPct: Number(process.env.MAX_DRAWDOWN_PCT ?? 20),
  },

  // ── Crypto venue (Phase 3, paper mode) ──
  crypto: {
    /** 'auto' = top pairs by 24h quote volume, or a comma list (BTCUSDT,...). */
    pairs: process.env.CRYPTO_PAIRS ?? 'auto',
    maxPairs: Number(process.env.CRYPTO_MAX_PAIRS ?? 50),
    timeframeSec: Number(process.env.CRYPTO_TIMEFRAME_SEC ?? 60),
  },

  // ── Funding-rate harvester (Phase 4, paper mode) ──
  funding: {
    /** Open a paper position when annualized funding exceeds this %. */
    enterApr: Number(process.env.FUNDING_ENTER_APR ?? 15),
    /** Close it when annualized funding falls below this %. */
    exitApr: Number(process.env.FUNDING_EXIT_APR ?? 5),
    /** Rate poll interval, minutes. */
    pollMin: Number(process.env.FUNDING_POLL_MIN ?? 5),
    /** Round-trip cost (spot+perp, open+close) as % of notional — charged to the paper PnL. */
    feeRoundTripPct: Number(process.env.FUNDING_FEE_PCT ?? 0.2),
    /** Max simultaneous paper positions. */
    maxPositions: Number(process.env.FUNDING_MAX_POSITIONS ?? 5),
    /** Paper notional per position (account currency). */
    notional: Number(process.env.FUNDING_NOTIONAL ?? 1000),
  },
};

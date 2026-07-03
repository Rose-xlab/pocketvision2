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
};

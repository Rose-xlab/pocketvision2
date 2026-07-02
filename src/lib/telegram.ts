/**
 * Telegram alert delivery (brief §4).
 *
 * Formats streak alerts exactly like the brief and sends them via the Bot API.
 * A small queue batches alerts that fire close together into one message and
 * throttles sends (~1/sec per chat) to stay within Telegram's rate limits.
 *
 * Credentials come from env (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — never
 * hardcoded. If unset, the sender degrades to a no-op with a one-time warning so
 * the scanner still runs (console alerts only).
 */
import type { StreakAlert } from '../scanner/streaks.js';

const MIN_SEND_INTERVAL_MS = 1200;

/** "EURUSD_otc" → "EUR/USD OTC"; "#AAPL_otc" → "AAPL OTC". Prefer catalog label. */
export function prettySymbol(symbol: string, label?: string): string {
  if (label) return label;
  let s = symbol.replace(/^#/, '');
  const otc = /_otc$/i.test(s);
  s = s.replace(/_otc$/i, '');
  if (/^[A-Za-z]{6}$/.test(s)) s = `${s.slice(0, 3)}/${s.slice(3)}`;
  return `${s.toUpperCase()}${otc ? ' OTC' : ''}`;
}

function timeframeLabel(sec: number): string {
  if (sec % 60 === 0) { const m = sec / 60; return `${m} minute${m === 1 ? '' : 's'}`; }
  return `${sec} second${sec === 1 ? '' : 's'}`;
}

/** UTC "YYYY-MM-DD HH:MM:SS". */
function fmtTime(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

export function formatAlert(alert: StreakAlert, timeframeSec: number, label?: string, payout?: number): string {
  const dot = alert.colour === 'red' ? '🔴' : '🟢';
  const name = prettySymbol(alert.symbol, label);
  return [
    `${dot} ${name} - ${alert.count} ${alert.colour} candles`,
    ...(payout !== undefined ? [`Payout: ${payout}%`] : []),
    `Timeframe: ${timeframeLabel(timeframeSec)}`,
    `Last candle time: ${fmtTime(alert.candle.periodStart)} UTC`,
    `Open: ${alert.candle.open} | Close: ${alert.candle.close}`,
    `Source: Pocket Option live feed`,
  ].join('\n');
}

export class TelegramSender {
  private readonly enabled: boolean;
  private queue: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private warned = false;

  constructor(private readonly token: string, private readonly chatId: string) {
    this.enabled = Boolean(token && chatId);
  }

  get isEnabled(): boolean { return this.enabled; }

  /** Queue a message; batched + throttled before hitting the API. */
  enqueue(text: string): void {
    if (!this.enabled) {
      if (!this.warned) { console.warn('  (Telegram disabled: set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to send)'); this.warned = true; }
      return;
    }
    this.queue.push(text);
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), MIN_SEND_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length).join('\n\n');
    await this.send(batch);
    if (this.queue.length > 0) this.timer = setTimeout(() => void this.flush(), MIN_SEND_INTERVAL_MS);
  }

  /** Send immediately (used for the startup test message). Returns ok. */
  async send(text: string): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`  ! Telegram send failed (${res.status}): ${body.slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`  ! Telegram send error: ${(err as Error).message}`);
      return false;
    }
  }

  /** Flush any pending messages (call before exit). */
  async drain(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.flush();
  }
}

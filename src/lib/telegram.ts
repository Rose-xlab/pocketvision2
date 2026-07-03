/**
 * Telegram alert delivery (brief §4).
 *
 * Formats streak alerts exactly like the brief and sends them via the Bot API.
 * A small queue batches alerts that fire close together into one message and
 * throttles sends (~1/sec per chat) to stay within Telegram's rate limits.
 *
 * Credentials come from env (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — never
 * hardcoded. TELEGRAM_CHAT_ID may be a single id or a comma-separated list
 * (users, groups, or channels); every message goes to each chat. If unset, the
 * sender degrades to a no-op with a one-time warning so the scanner still runs
 * (console alerts only).
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

  private readonly chatIds: string[];

  constructor(private readonly token: string, chatId: string) {
    this.chatIds = chatId.split(',').map((s) => s.trim()).filter(Boolean);
    this.enabled = Boolean(token && this.chatIds.length > 0);
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

  /** Send immediately to every configured chat. Returns true if ALL succeeded. */
  async send(text: string): Promise<boolean> {
    if (!this.enabled) return false;
    let allOk = true;
    for (const chatId of this.chatIds) {
      if (!(await this.sendTo(chatId, text))) allOk = false;
    }
    return allOk;
  }

  private async sendTo(chatId: string, text: string, attempt = 1): Promise<boolean> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 4xx = our fault (bad chat id etc.) — retrying can't help. 5xx might.
        if (res.status >= 500 && attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          return this.sendTo(chatId, text, attempt + 1);
        }
        console.error(`  ! Telegram send failed for chat ${chatId} (${res.status}): ${body.slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (err) {
      // Network blip (fetch failed) — an alert is worth a couple of retries.
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        return this.sendTo(chatId, text, attempt + 1);
      }
      console.error(`  ! Telegram send error for chat ${chatId} after ${attempt} tries: ${(err as Error).message}`);
      return false;
    }
  }

  /** Flush any pending messages (call before exit). */
  async drain(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.flush();
  }
}

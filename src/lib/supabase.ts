/**
 * Supabase persistence (Phase 4).
 *
 * Thin PostgREST client over fetch — no SDK dependency. Rows are inserted
 * fire-and-forget: a failed insert is logged and dropped, never allowed to
 * stall or crash the scanner (Telegram remains the instant-alert path; this
 * is the durable history behind it).
 *
 * Credentials come from env (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — the
 * service key belongs on the VPS scanner ONLY, never in a browser). If unset,
 * every call is a silent no-op so local runs work unchanged.
 */
import type { StreakAlert } from '../scanner/streaks.js';
import type { OutcomeRecord } from '../scanner/outcomes.js';

const iso = (epochSec: number) => new Date(epochSec * 1000).toISOString();

export class SupabaseSink {
  private readonly enabled: boolean;
  private failures = 0;

  constructor(private readonly url: string, private readonly serviceKey: string) {
    this.enabled = Boolean(url && serviceKey);
  }

  get isEnabled(): boolean { return this.enabled; }

  private async insert(table: string, row: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await fetch(`${this.url}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
          apikey: this.serviceKey,
          authorization: `Bearer ${this.serviceKey}`,
          'content-type': 'application/json',
          prefer: 'return=minimal',
        },
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.warn(`insert ${table} → ${res.status}: ${body.slice(0, 160)}`);
      }
    } catch (err) {
      this.warn(`insert ${table} failed: ${(err as Error).message}`);
    }
  }

  /** Log the first few failures loudly, then go quiet (network blips happen). */
  private warn(msg: string): void {
    this.failures++;
    if (this.failures <= 5) console.error(`  ! Supabase ${msg}`);
    if (this.failures === 5) console.error('  ! Supabase: further errors suppressed');
  }

  alert(a: StreakAlert, meta: { payout?: number; label?: string }, timeframeSec: number): void {
    void this.insert('alerts', {
      symbol: a.symbol,
      label: meta.label ?? null,
      payout: meta.payout ?? null,
      streak: a.count,
      colour: a.colour,
      timeframe_sec: timeframeSec,
      period_start: iso(a.candle.periodStart),
    });
  }

  outcome(r: OutcomeRecord): void {
    void this.insert('outcomes', {
      symbol: r.symbol,
      label: r.label ?? null,
      payout: r.payout ?? null,
      streak: r.streak,
      colour: r.colour,
      timeframe_sec: r.timeframeSec,
      alert_period_start: iso(r.alertPeriodStart),
      outcome: r.outcome,
      next_open: r.next?.open ?? null,
      next_high: r.next?.high ?? null,
      next_low: r.next?.low ?? null,
      next_close: r.next?.close ?? null,
    });
  }

  heartbeat(h: { connsLive?: number; connsTotal?: number; pairs: number; alerts: number; summary: string }): void {
    void this.insert('heartbeats', {
      conns_live: h.connsLive ?? null,
      conns_total: h.connsTotal ?? null,
      pairs: h.pairs,
      alerts: h.alerts,
      summary: h.summary,
    });
  }
}

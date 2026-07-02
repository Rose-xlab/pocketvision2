/**
 * Phase 1 analysis — turns a stream of parsed frames into evidence for the
 * ONE question that gates the whole project:
 *
 *   Does the Pocket Option feed expose ALL pairs at once, or only the
 *   currently-selected pair?
 *
 * We do this by counting, per Socket.IO event, how many *distinct asset
 * symbols* show up while the user is NOT switching assets. If a single
 * streaming event carries many symbols → all-pairs feed. If every data event
 * only ever mentions one symbol → selected-pair-only (asset-cycling fallback).
 *
 * Symbol detection is heuristic on purpose: we don't yet know PO's exact
 * schema (that's what the spike is for), so we also keep raw samples for a
 * human to eyeball.
 */
import type { ParsedFrame } from '../lib/socketio.js';
import { redactValue } from '../lib/redact.js';

/** Looks like an asset symbol: EURUSD, EURUSD_otc, XAUUSD, #AAPL, UK100, BTCUSD… */
const SYMBOL_RE = /^#?[A-Za-z][A-Za-z0-9]{1,9}([/_-][A-Za-z0-9]{1,6})?(_otc)?$/;
const SYMBOL_KEYS = /^(asset|symbol|active|pair|ric|instrument|ticker)$/i;

/**
 * Events that mention symbols but are NOT the market feed — chat "Signals",
 * support rooms, account/deal updates. Excluded from the all-pairs verdict so
 * chatter can't masquerade as a multi-pair data stream.
 */
const NOISE_EVENT = /chat|room|chafor|signal|message|counter|deal|balance|pending|express|favorite|alert/i;

function looksLikeSymbol(s: string): boolean {
  if (!SYMBOL_RE.test(s)) return false;
  // Must contain letters and be plausibly a market symbol, not a random word.
  const upper = s.replace(/[^A-Za-z]/g, '');
  if (upper.length < 3) return false;
  const isMostlyUpper = upper === upper.toUpperCase();
  return isMostlyUpper || /_otc$/i.test(s) || s.startsWith('#');
}

/** Recursively pull candidate symbols out of an event's args. */
function collectSymbols(value: unknown, into: Set<string>, keyHint = false): void {
  if (typeof value === 'string') {
    if (keyHint || looksLikeSymbol(value)) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectSymbols(v, into, keyHint);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectSymbols(v, into, SYMBOL_KEYS.test(k));
    }
  }
}

/** Collect hexHead fingerprints of any opaque (undecoded) binary attachments. */
function findOpaqueBinary(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) findOpaqueBinary(v, into);
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.__binary === true && typeof obj.hexHead === 'string') into.push(obj.hexHead);
    else for (const v of Object.values(obj)) findOpaqueBinary(v, into);
  }
  return into;
}

export interface EventStat {
  event: string;
  namespace?: string;
  frames: number;
  symbols: Set<string>;
  /** A few redacted, truncated payload samples for human inspection. */
  samples: string[];
}

export class SpikeAnalyzer {
  readonly events = new Map<string, EventStat>();
  readonly allSymbols = new Set<string>();
  totalFrames = 0;
  heartbeats = 0;
  binaryFrames = 0;
  unparsedFrames = 0;
  /** Binary events successfully reassembled + decoded as JSON. */
  binaryJsonEvents = 0;
  /** Binary attachments that were opaque (non-JSON, e.g. msgpack). */
  opaqueBinaryEvents = 0;
  /** hexHead fingerprints of opaque binary payloads, for identifying the codec. */
  readonly opaqueFingerprints = new Set<string>();
  private readonly maxSamples = 3;

  add(frame: ParsedFrame): void {
    this.totalFrames++;
    if (frame.heartbeat) { this.heartbeats++; return; }
    if (frame.json === undefined) { this.unparsedFrames++; return; }
    if (!frame.event) return;

    const key = `${frame.namespace ?? ''}::${frame.event}`;
    let stat = this.events.get(key);
    if (!stat) {
      stat = { event: frame.event, namespace: frame.namespace, frames: 0, symbols: new Set(), samples: [] };
      this.events.set(key, stat);
    }
    stat.frames++;

    // Track how binary events decoded, and fingerprint any opaque payloads.
    if (frame.args) {
      const opaque = findOpaqueBinary(frame.args);
      if (opaque.length > 0) {
        this.opaqueBinaryEvents++;
        for (const hp of opaque) this.opaqueFingerprints.add(hp);
      } else if (frame.socketType === 5) {
        this.binaryJsonEvents++;
      }
    }

    collectSymbols(frame.args, stat.symbols);
    for (const s of stat.symbols) this.allSymbols.add(s);

    if (stat.samples.length < this.maxSamples) {
      // Redact before storing — samples land in the diagnostics report on disk.
      const sample = JSON.stringify(redactValue(frame.args))?.slice(0, 400);
      if (sample) stat.samples.push(sample);
    }
  }

  markBinary(): void { this.totalFrames++; this.binaryFrames++; }

  /** The headline verdict, with the evidence behind it. */
  verdict(): {
    conclusion: 'all-pairs' | 'selected-only' | 'inconclusive';
    reason: string;
    /** Size of the biggest asset-catalog dump seen (available pairs). */
    catalogSize: number;
    topDataEvents: { event: string; frames: number; distinctSymbols: number; role: 'catalog' | 'stream' }[];
  } {
    const data = [...this.events.values()].filter((e) => e.symbols.size > 0 && !NOISE_EVENT.test(e.event));

    // A "catalog" dump = many symbols in very few frames (e.g. updateAssets:
    // 207 symbols in 1 frame). A "stream" = candles/ticks over many frames.
    const isCatalog = (e: EventStat) => e.symbols.size >= 10 && e.frames <= 3;
    const catalog = data.filter(isCatalog);
    const stream = data.filter((e) => !isCatalog(e)).sort((a, b) => b.symbols.size - a.symbols.size || b.frames - a.frames);
    const catalogSize = catalog.reduce((m, e) => Math.max(m, e.symbols.size), 0);

    const label = (e: EventStat) => (e.namespace ? `${e.namespace}:${e.event}` : e.event);
    const topDataEvents = [...catalog, ...stream].slice(0, 6).map((e) => ({
      event: label(e),
      frames: e.frames,
      distinctSymbols: e.symbols.size,
      role: (isCatalog(e) ? 'catalog' : 'stream') as 'catalog' | 'stream',
    }));

    const catalogNote = catalogSize > 0 ? ` A full asset catalog of ${catalogSize} pairs is available for building a watchlist.` : '';

    // The verdict hinges on the LIVE STREAM, not the catalog dump.
    const multiStream = stream.find((e) => e.symbols.size >= 3);
    if (multiStream) {
      return {
        conclusion: 'all-pairs',
        catalogSize,
        reason: `Live-stream event "${multiStream.event}" carried ${multiStream.symbols.size} distinct symbols across ${multiStream.frames} frames without switching assets — the feed broadcasts many pairs at once. Build true multi-pair scanning.${catalogNote}`,
        topDataEvents,
      };
    }
    if (stream.length > 0 && stream.every((e) => e.symbols.size <= 1)) {
      const s = stream[0]!;
      return {
        conclusion: 'selected-only',
        catalogSize,
        reason: `The live stream ("${s.event}", ${s.frames} frames) only carried the single selected pair — candles flow only for what you subscribe to.${catalogNote} Phase 3 must either (a) test whether one socket accepts many simultaneous subfor subscriptions, or (b) fall back to asset-cycling.`,
        topDataEvents,
      };
    }
    if (this.opaqueBinaryEvents > 0 && stream.length === 0) {
      const fp = [...this.opaqueFingerprints].slice(0, 3).join(', ');
      return {
        conclusion: 'inconclusive',
        catalogSize,
        reason: `The feed's binary payloads did not decode as JSON (likely msgpack/compressed). ${this.opaqueBinaryEvents} opaque attachments seen; fingerprints: ${fp || 'n/a'}. Next step: add the matching binary codec, then re-run.`,
        topDataEvents,
      };
    }
    return {
      conclusion: 'inconclusive',
      catalogSize,
      reason: `No clear live-stream evidence yet.${catalogNote} Let it run longer with one pair selected, or inspect the JSONL log by hand.`,
      topDataEvents,
    };
  }

  report(): string {
    const v = this.verdict();
    const lines: string[] = [];
    lines.push('═══════════════════════════════════════════════════════');
    lines.push('  PHASE 1 — FEED DISCOVERY SUMMARY');
    lines.push('═══════════════════════════════════════════════════════');
    lines.push(`  Frames total:      ${this.totalFrames}`);
    lines.push(`   ├─ heartbeats:    ${this.heartbeats}`);
    lines.push(`   ├─ binary(orphan):${this.binaryFrames}`);
    lines.push(`   └─ unparsed:      ${this.unparsedFrames}`);
    lines.push(`  Binary events:     ${this.binaryJsonEvents} decoded as JSON, ${this.opaqueBinaryEvents} opaque`);
    if (this.opaqueFingerprints.size > 0) {
      lines.push(`  Opaque fingerprints: ${[...this.opaqueFingerprints].slice(0, 4).join(' | ')}`);
    }
    lines.push(`  Distinct events:   ${this.events.size}`);
    lines.push(`  Distinct symbols:  ${this.allSymbols.size}`);
    lines.push('');
    if (v.catalogSize > 0) lines.push(`  Asset catalog:     ${v.catalogSize} pairs available (watchlist source)`);
    lines.push('');
    lines.push('  Data-bearing events (catalog vs live stream):');
    for (const e of v.topDataEvents) {
      const tag = e.role === 'catalog' ? '[catalog]' : '[stream] ';
      lines.push(`    • ${tag} ${e.event}  —  ${e.distinctSymbols} symbols, ${e.frames} frames`);
    }
    if (this.allSymbols.size > 0) {
      const sample = [...this.allSymbols].slice(0, 20).join(', ');
      lines.push('');
      lines.push(`  Symbols seen (up to 20): ${sample}${this.allSymbols.size > 20 ? ' …' : ''}`);
    }
    lines.push('');
    lines.push(`  ►► VERDICT: ${v.conclusion.toUpperCase()}`);
    lines.push(`     ${v.reason}`);
    lines.push('═══════════════════════════════════════════════════════');
    return lines.join('\n');
  }

  /** JSON-serializable snapshot for the diagnostics report. */
  toJSON() {
    const v = this.verdict();
    return {
      totalFrames: this.totalFrames,
      heartbeats: this.heartbeats,
      binaryOrphanFrames: this.binaryFrames,
      unparsedFrames: this.unparsedFrames,
      binaryJsonEvents: this.binaryJsonEvents,
      opaqueBinaryEvents: this.opaqueBinaryEvents,
      opaqueFingerprints: [...this.opaqueFingerprints],
      distinctEvents: this.events.size,
      distinctSymbols: this.allSymbols.size,
      symbols: [...this.allSymbols],
      verdict: v,
      events: [...this.events.values()].map((e) => ({
        event: e.event,
        namespace: e.namespace,
        frames: e.frames,
        distinctSymbols: e.symbols.size,
        symbols: [...e.symbols],
        samples: e.samples,
      })),
    };
  }
}

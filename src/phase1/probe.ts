/**
 * Phase 1 — multi-subscribe probe (the Phase 3 architecture decision).
 *
 * Phase 1 established the live feed is SELECTED-ONLY: candles only flow for the
 * pair you subscribe to. But streak scanning needs many pairs at once. This
 * probe answers whether ONE socket can carry many pairs:
 *
 *   1. Patch window.WebSocket before PO loads, keeping a handle to send frames.
 *   2. Let PO subscribe to its one selected pair (baseline).
 *   3. Inject extra `subfor` subscriptions for several OTC pairs on the SAME
 *      market socket.
 *   4. Watch whether `updateStream` starts delivering those extra pairs.
 *
 * SUPPORTED  → Phase 3 = one connection, many pairs (elegant).
 * NOT-SUPPORTED → Phase 3 = one connection per pair (tabs / parallel clients).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config.js';
import { openPersistentContext, firstPage, dismissPopups } from '../lib/browser.js';
import { attachCapture } from './capture.js';

const BASELINE_MS = 15_000;   // collect catalog + PO's own subscription
const OBSERVE_MS = 20_000;    // watch for injected pairs after subscribing
const MAX_INJECT = 6;         // how many extra pairs to try

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Runs in the browser: wrap WebSocket so we can send raw frames on PO's socket. */
function installWebSocketTap(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__poPatched) return;
  w.__poPatched = true;
  const OrigWS = window.WebSocket;
  const sockets: { url: string; ws: WebSocket }[] = [];
  w.__poSockets = sockets;
  w.WebSocket = new Proxy(OrigWS, {
    construct(target, args: unknown[]) {
      const ws = Reflect.construct(target, args) as WebSocket;
      try { sockets.push({ url: String(args[0]), ws }); } catch { /* ignore */ }
      return ws;
    },
  });
  w.__poSend = (urlSubstr: string, frames: string[]): number => {
    let sent = 0;
    for (const s of sockets) {
      if (s.url.includes(urlSubstr) && s.ws.readyState === 1) {
        for (const f of frames) { try { s.ws.send(f); sent++; } catch { /* ignore */ } }
      }
    }
    return sent;
  };
}

/** Recursively collect symbol-like strings from a decoded event payload. */
function stringsIn(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') { if (/[A-Za-z]/.test(value) && value.length <= 14) into.add(value); return; }
  if (Array.isArray(value)) { for (const v of value) stringsIn(v, into); return; }
  if (value && typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) stringsIn(v, into);
}

async function main() {
  if (!fs.existsSync(paths.chromeProfile)) {
    console.error(`No saved profile at ${paths.chromeProfile}.\nRun:  npm run login  first.`);
    process.exit(1);
  }
  fs.mkdirSync(paths.diagnosticsDir, { recursive: true });

  // State collected from the feed.
  const catalog = new Map<string, { isOpen: boolean }>();
  const baselineStream = new Set<string>();
  const postStream = new Set<string>();
  let currentSymbol: string | null = null;
  let marketUrl: string | null = null;
  let injectionDone = false;

  const context = await openPersistentContext({ headless: config.headless });
  await context.addInitScript(installWebSocketTap);
  const page = await firstPage(context);

  attachCapture(context, (frame, _dir, url) => {
    if (!frame || !frame.event) return;
    switch (frame.event) {
      case 'updateAssets': {
        const entries = (frame.args?.[0] as unknown[]) ?? [];
        for (const e of entries) {
          if (Array.isArray(e) && typeof e[1] === 'string') {
            catalog.set(e[1], { isOpen: e[14] === true });
          }
        }
        break;
      }
      case 'subfor':
        if (!currentSymbol && typeof frame.args?.[0] === 'string') currentSymbol = frame.args[0];
        break;
      case 'changeSymbol': {
        const a = frame.args?.[0] as { asset?: string } | undefined;
        if (a?.asset) currentSymbol = a.asset;
        break;
      }
      case 'updateStream': {
        if (url.includes('po.market')) marketUrl = url;
        const syms = new Set<string>();
        stringsIn(frame.args, syms);
        for (const s of syms) (injectionDone ? postStream : baselineStream).add(s);
        break;
      }
    }
  });

  console.log(`\n→ Opening ${config.poCabinetUrl} …`);
  await page.goto(config.poCabinetUrl, { waitUntil: 'domcontentloaded' }).catch((e) => console.log(`  (nav note: ${e.message})`));
  await page.waitForTimeout(2500);
  await dismissPopups(page);

  console.log(`\n[1/3] Baseline — letting PO subscribe to its selected pair (${Math.round(BASELINE_MS / 1000)}s)…`);
  await page.waitForTimeout(BASELINE_MS);
  console.log(`  • Selected pair: ${currentSymbol ?? '(unknown)'}`);
  console.log(`  • Catalog size:  ${catalog.size}`);
  console.log(`  • Baseline stream symbols: ${[...baselineStream].join(', ') || '(none yet)'}`);

  // Pick open OTC pairs (24/7) different from the selected one to subscribe to.
  const targets = [...catalog.entries()]
    .filter(([sym, m]) => m.isOpen && sym !== currentSymbol && /_otc$/i.test(sym) && !baselineStream.has(sym))
    .slice(0, MAX_INJECT)
    .map(([sym]) => sym);

  if (targets.length === 0) {
    console.log('\n! No open OTC targets found in the catalog to inject. Try again when markets are active.');
    await context.close();
    return;
  }

  const frames = targets.map((s) => `42["subfor",${JSON.stringify(s)}]`);
  console.log(`\n[2/3] Injecting ${targets.length} extra subscriptions on ${marketUrl ?? 'api-*.po.market'}:`);
  console.log(`  ${targets.join(', ')}`);
  injectionDone = true;
  const sent = await page.evaluate(
    ({ url, f }) => (window as unknown as { __poSend: (u: string, fr: string[]) => number }).__poSend(url, f),
    { url: 'po.market', f: frames },
  );
  console.log(`  • Frames sent on live socket: ${sent}`);

  console.log(`\n[3/3] Observing for injected pairs (${Math.round(OBSERVE_MS / 1000)}s)…`);
  await page.waitForTimeout(OBSERVE_MS);

  const targetsSeen = targets.filter((s) => postStream.has(s));
  const newlyStreamed = [...postStream].filter((s) => !baselineStream.has(s));
  const supported = targetsSeen.length > 0;

  const report = {
    when: new Date().toISOString(),
    selectedSymbol: currentSymbol,
    catalogSize: catalog.size,
    marketUrl,
    injected: targets,
    framesSent: sent,
    baselineStreamSymbols: [...baselineStream],
    postStreamSymbols: [...postStream],
    newlyStreamedAfterInjection: newlyStreamed,
    injectedPairsSeen: targetsSeen,
    verdict: supported ? 'MULTI-SUBSCRIBE-SUPPORTED' : 'MULTI-SUBSCRIBE-NOT-SUPPORTED',
  };
  const reportPath = path.join(paths.diagnosticsDir, `probe-${ts()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  MULTI-SUBSCRIBE PROBE RESULT');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Injected pairs:        ${targets.join(', ')}`);
  console.log(`  Injected pairs seen:   ${targetsSeen.join(', ') || '(none)'}`);
  console.log(`  Other new symbols:     ${newlyStreamed.filter((s) => !targetsSeen.includes(s)).join(', ') || '(none)'}`);
  console.log('');
  if (supported) {
    console.log(`  ►► SUPPORTED — one socket streamed ${targetsSeen.length} extra pair(s) after injecting subfor.`);
    console.log('     Phase 3 = single connection, many pairs (subscribe to the whole watchlist).');
  } else {
    console.log('  ►► NOT SUPPORTED via subfor injection — no injected pair started streaming.');
    console.log('     Phase 3 = one connection per pair (multiple tabs / parallel Socket.IO clients).');
  }
  console.log(`\n  Report: ${reportPath}`);
  console.log('═══════════════════════════════════════════════════════');

  await context.close();
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});

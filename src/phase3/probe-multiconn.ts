/**
 * Phase 3 — multi-connection keystone spike.
 *
 * Phase 1 showed one connection streams only its selected pair, and injecting
 * extra `subfor` on that connection does nothing. The remaining question that
 * decides Phase 3's whole architecture:
 *
 *   Can we open a SECOND Socket.IO connection (reusing the same browser session
 *   auth) and have it stream a DIFFERENT pair — i.e. do N parallel connections
 *   scale, or does PO bind one session to one connection?
 *
 * How it works: we tap window.WebSocket to capture PO's own `auth` frame, then
 * open a second raw WebSocket to the same api-*.po.market URL from inside the
 * page (same origin / IP / session), replay the handshake + captured auth, and
 * subscribe it to a target pair. Playwright observes the new socket's frames, so
 * we detect in Node whether the target pair's ticks arrive.
 *
 *   SCALES        → Phase 3 = pool of parallel connections, one (or few) pair each.
 *   DOES-NOT-SCALE → fall back to multiple browser tabs / asset-cycling.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config.js';
import { openPersistentContext, firstPage, dismissPopups } from '../lib/browser.js';
import { attachCapture } from '../phase1/capture.js';

const BASELINE_MS = 13_000;
const OBSERVE_MS = 20_000;

function ts(): string { return new Date().toISOString().replace(/[:.]/g, '-'); }

/** In-page: tap WebSocket to capture PO's auth frame, and expose a 2nd-connection opener. */
function installTap(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__tapInstalled) return;
  w.__tapInstalled = true;
  const OrigWS = window.WebSocket;

  w.WebSocket = new Proxy(OrigWS, {
    construct(target, args: unknown[]) {
      const ws = Reflect.construct(target, args) as WebSocket;
      const url = String(args[0]);
      const origSend = ws.send.bind(ws);
      ws.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        try {
          if (typeof data === 'string' && data.startsWith('42["auth"') && url.includes('po.market')) {
            w.__poAuth = { url, frame: data };
          }
        } catch { /* ignore */ }
        return origSend(data as string);
      };
      return ws;
    },
  });

  // Open a fresh connection (using the ORIGINAL WebSocket so our proxy doesn't recurse).
  // Subscribes to MULTIPLE targets to learn how many pairs one connection can serve.
  w.__openSecond = (url: string, authFrame: string, targets: string[]): boolean => {
    const log: string[] = [];
    w.__secondLog = log;
    const ws = new OrigWS(url);
    ws.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (typeof d !== 'string') { return; }
      if (d[0] === '0') { ws.send('40'); log.push('open→40'); }
      else if (d.slice(0, 2) === '40') { ws.send(authFrame); log.push('connected→auth'); }
      else if (d.indexOf('successauth') >= 0) {
        ws.send(`42["changeSymbol",{"asset":"${targets[0]}","period":1}]`);
        for (const t of targets) ws.send(`42["subfor","${t}"]`);
        log.push(`auth→subfor ${targets.length}: ${targets.join(',')}`);
      }
    };
    ws.onerror = () => log.push('error');
    ws.onclose = () => log.push('close');
    return true;
  };
}

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

  const catalog = new Map<string, { isOpen: boolean }>();
  let selectedSymbol: string | null = null;
  let injected = false;
  let targets: string[] = [];
  const targetTicks = new Map<string, number>();
  let selectedTicksAfter = 0;

  const context = await openPersistentContext({ headless: config.headless });
  await context.addInitScript(installTap);
  const page = await firstPage(context);

  attachCapture(context, (frame) => {
    if (!frame?.event) return;
    if (frame.event === 'updateAssets') {
      for (const e of (frame.args?.[0] as unknown[]) ?? []) {
        if (Array.isArray(e) && typeof e[1] === 'string') catalog.set(e[1], { isOpen: e[14] === true });
      }
    } else if (frame.event === 'subfor' && !selectedSymbol && typeof frame.args?.[0] === 'string') {
      selectedSymbol = frame.args[0];
    } else if (frame.event === 'changeSymbol') {
      const a = frame.args?.[0] as { asset?: string } | undefined;
      if (a?.asset && !selectedSymbol) selectedSymbol = a.asset;
    } else if (frame.event === 'updateStream') {
      const syms = new Set<string>();
      stringsIn(frame.args, syms);
      if (injected) {
        for (const t of targets) if (syms.has(t)) targetTicks.set(t, (targetTicks.get(t) ?? 0) + 1);
        if (selectedSymbol && syms.has(selectedSymbol)) selectedTicksAfter++;
      }
    }
  });

  console.log(`\n→ Opening ${config.poCabinetUrl} …`);
  await page.goto(config.poCabinetUrl, { waitUntil: 'domcontentloaded' }).catch((e) => console.log(`  (nav note: ${e.message})`));
  await page.waitForTimeout(2500);
  await dismissPopups(page);

  console.log(`\n[1/3] Baseline (${Math.round(BASELINE_MS / 1000)}s) — PO connects, authenticates, subscribes…`);
  await page.waitForTimeout(BASELINE_MS);

  const auth = await page.evaluate(() => (window as unknown as { __poAuth?: { url: string; frame: string } }).__poAuth);
  if (!auth) {
    console.error('\n! Did not capture PO auth frame. Make sure the terminal/chart is open, then retry.');
    await context.close();
    process.exit(1);
  }
  console.log(`  • Selected pair: ${selectedSymbol ?? '(unknown)'}`);
  console.log(`  • Market socket: ${auth.url}`);
  console.log(`  • Auth frame captured: yes`);

  targets = [...catalog.entries()]
    .filter(([sym, m]) => m.isOpen && sym !== selectedSymbol && /_otc$/i.test(sym))
    .map(([sym]) => sym)
    .slice(0, 5);
  if (targets.length === 0) { console.error('! No open OTC targets found to test.'); await context.close(); return; }

  console.log(`\n[2/3] Opening ONE second connection, subscribing it to ${targets.length} pairs:`);
  console.log(`  ${targets.join(', ')}`);
  injected = true;
  await page.evaluate(
    ({ u, f, t }) => (window as unknown as { __openSecond: (u: string, f: string, t: string[]) => boolean }).__openSecond(u, f, t),
    { u: auth.url, f: auth.frame, t: targets },
  );

  console.log(`\n[3/3] Observing (${Math.round(OBSERVE_MS / 1000)}s)…`);
  await page.waitForTimeout(OBSERVE_MS);

  const secondLog = await page.evaluate(() => (window as unknown as { __secondLog?: string[] }).__secondLog ?? []);
  const streamed = targets.filter((t) => (targetTicks.get(t) ?? 0) > 0);
  const firstConnAlive = selectedTicksAfter > 0;
  const perPair = Object.fromEntries(targets.map((t) => [t, targetTicks.get(t) ?? 0]));

  const report = {
    when: new Date().toISOString(),
    selectedSymbol, targets, marketUrl: auth.url,
    secondConnectionLog: secondLog,
    ticksPerTarget: perPair,
    pairsRequested: targets.length,
    pairsStreamed: streamed.length,
    selectedTicksAfterSecondConn: selectedTicksAfter,
    firstConnectionStillStreaming: firstConnAlive,
    verdict:
      streamed.length === targets.length ? 'ONE-CONN-MANY-PAIRS'
      : streamed.length > 0 ? 'ONE-CONN-ONE-PAIR'
      : 'SECOND-CONN-FAILED',
  };
  const reportPath = path.join(paths.diagnosticsDir, `multiconn-${ts()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  MULTI-CONNECTION PROBE RESULT');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Second-connection steps: ${secondLog.join('  ›  ') || '(none — handshake did not progress)'}`);
  console.log(`  Pairs subscribed on ONE second connection: ${targets.length}`);
  for (const t of targets) console.log(`    • ${t}: ${targetTicks.get(t) ?? 0} ticks`);
  console.log(`  Selected "${selectedSymbol}" still streaming: ${firstConnAlive ? 'yes' : 'NO (first conn may have dropped)'}`);
  console.log('');
  if (streamed.length === targets.length) {
    console.log(`  ►► ONE CONNECTION SERVES MANY PAIRS — all ${targets.length} streamed on a single socket.`);
    console.log('     Phase 3 = a few connections cover the whole catalog. Very light.');
  } else if (streamed.length > 0) {
    console.log(`  ►► ONE PAIR PER CONNECTION — only ${streamed.length}/${targets.length} streamed (${streamed.join(', ')}).`);
    console.log('     Phase 3 = a connection pool, ~one pair each.');
  } else {
    console.log('  ►► SECOND CONNECTION FAILED — no target streamed. Re-check handshake/auth.');
  }
  console.log(`\n  Report: ${reportPath}`);
  console.log('═══════════════════════════════════════════════════════');

  await context.close();
}

main().catch((err) => { console.error('Multi-conn probe failed:', err); process.exit(1); });

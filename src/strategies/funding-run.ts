/**
 * Funding harvester runner — polls public funding rates on an interval and
 * drives the paper simulator. No API keys, no orders; the journal is the
 * deliverable (npm run report shows realized paper APY).
 *
 * Run:  npm run funding   (FUNDING_* knobs in .env)
 */
import readline from 'node:readline';
import { config, paths } from '../config.js';
import { TelegramSender } from '../lib/telegram.js';
import { fetchBinanceFunding, fetchBybitFunding, FundingHarvester, type FundingRate } from './funding.js';

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

async function fetchAllRates(): Promise<FundingRate[]> {
  const out: FundingRate[] = [];
  const sources: [string, () => Promise<FundingRate[]>][] = [
    ['binance', fetchBinanceFunding],
    ['bybit', fetchBybitFunding],
  ];
  for (const [name, fn] of sources) {
    try { out.push(...(await fn())); }
    catch (e) { console.warn(`  (rates from ${name} failed: ${(e as Error).message})`); }
  }
  return out;
}

async function main() {
  const telegram = new TelegramSender(config.telegram.token, config.telegram.chatId);
  const harvester = new FundingHarvester(config.funding, paths.fundingFile, (e) => {
    if (e.type === 'open') {
      const msg = `🌾 FUNDING PAPER: opened ${e.symbol} on ${e.source} @ ${e.apr.toFixed(1)}% APR (notional ${e.notional})`;
      console.log(`  ${msg}`);
      telegram.enqueue(msg);
    } else if (e.type === 'close') {
      const msg = `🌾 FUNDING PAPER: closed ${e.symbol} (${e.source}) after ${e.holdHours}h — accrued ${e.accrued}, fees ${e.fees}, realized ${e.realized >= 0 ? '+' : ''}${e.realized}`;
      console.log(`  ${msg}`);
      telegram.enqueue(msg);
    }
  });

  console.log('\n─────────────────────────────────────────────────────');
  console.log('  FUNDING-RATE HARVESTER (paper mode, public data only)');
  console.log(`  • Enter ≥ ${config.funding.enterApr}% APR | exit < ${config.funding.exitApr}% | fee ${config.funding.feeRoundTripPct}% round-trip`);
  console.log(`  • Max ${config.funding.maxPositions} positions × ${config.funding.notional} notional | poll every ${config.funding.pollMin}m`);
  console.log(`  • Resumed ${harvester.positions.size} open paper position(s) from the journal`);
  console.log(`  • Journal → ${paths.fundingFile}`);
  console.log('  • Press ENTER (or send SIGTERM) to stop.');
  console.log('─────────────────────────────────────────────────────\n');

  let lastMarkMs = 0;
  const poll = async () => {
    const rates = await fetchAllRates();
    if (rates.length === 0) { console.warn('  (no rates this cycle — all sources failed)'); return; }
    harvester.step(rates);
    // Status: best opportunities + open book.
    const top = [...rates].sort((a, b) => b.apr - a.apr).slice(0, 5)
      .map((r) => `${r.symbol}@${r.source[0]} ${r.apr.toFixed(0)}%`);
    const open = [...harvester.positions.values()]
      .map((p) => `${p.symbol} +${p.accrued.toFixed(2)}`);
    console.log(`  [funding] ${rates.length} rates | top APR: ${top.join('  ')} | open: ${open.join('  ') || '—'}`);
    if (Date.now() - lastMarkMs > 3_600_000) { harvester.mark(rates); lastMarkMs = Date.now(); }
  };

  await poll();
  const timer = setInterval(() => void poll().catch((e) => console.warn(`  (poll failed: ${(e as Error).message})`)), config.funding.pollMin * 60_000);

  await waitForStop();
  clearInterval(timer);
  console.log(`\n  Open paper positions: ${harvester.positions.size} (journal has the trail)`);
  await telegram.drain();
}

main().catch((err) => { console.error('Funding harvester failed:', err); process.exit(1); });

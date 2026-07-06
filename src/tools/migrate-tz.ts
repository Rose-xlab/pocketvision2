/**
 * One-time migration: shift historical outcome records from PO platform time
 * to true UTC.
 *
 * Records written BEFORE the 2026-07-06 timestamp fix carry alertPeriodStart
 * (and post-alert candle periodStarts) in PO platform time (UTC+2 observed).
 * Records written after the fix are true UTC.
 *
 * Detection is per record and self-evident: `at` (the resolution wall clock,
 * always true UTC) is minutes AFTER the streak candle — so in a correct
 * record alertPeriodStart < at. A platform-time record has alertPeriodStart
 * ~2h in at's future. Anything > 15 min ahead gets shifted; everything else
 * is left alone — which also makes re-running this a no-op.
 *
 *   npm run migrate:tz            # shifts by PO_TIME_OFFSET_HOURS (default 2)
 *   npm run migrate:tz -- 3       # explicit hours
 *
 * Run with the PO scanner STOPPED. A timestamped .bak copy is written first.
 */
import fs from 'node:fs';
import { config, paths } from '../config.js';
import type { OutcomeRecord } from '../scanner/outcomes.js';

function main(): void {
  const hours = Number(process.argv[2] ?? config.poTimeOffsetHours);
  const shift = hours * 3600;
  const file = paths.outcomesFile;
  if (!Number.isFinite(shift) || shift === 0) { console.error(`Bad offset: ${process.argv[2]}`); process.exit(1); }
  if (!fs.existsSync(file)) { console.log(`Nothing to migrate — ${file} does not exist.`); return; }

  const backup = `${file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  fs.copyFileSync(file, backup);
  console.log(`Backup written: ${backup}`);

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let shifted = 0, alreadyUtc = 0, unparsed = 0;
  const out = lines.map((line) => {
    let rec: OutcomeRecord;
    try { rec = JSON.parse(line) as OutcomeRecord; } catch { unparsed++; return line; }
    const resolvedAtSec = Date.parse(rec.at) / 1000;
    if (!(rec.alertPeriodStart > resolvedAtSec + 900)) { alreadyUtc++; return line; } // plausible → true UTC already
    rec.alertPeriodStart -= shift;
    if (rec.next) rec.next.periodStart -= shift;
    if (rec.nexts) for (const nc of rec.nexts) if (nc) nc.periodStart -= shift;
    shifted++;
    return JSON.stringify(rec);
  });

  fs.writeFileSync(file, out.join('\n') + '\n');
  console.log(`Done: ${shifted} records shifted by -${hours}h, ${alreadyUtc} already true UTC, ${unparsed} unparsed (untouched).`);
  console.log('Note: rows already in Supabase keep platform time; the local JSONL is what the report reads.');
}

main();

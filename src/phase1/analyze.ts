/**
 * Phase 1 — offline re-analysis.
 *
 * Re-runs the analyzer over a previously captured JSONL frame log so you can
 * refine the verdict without opening a browser again:
 *
 *   npm run analyze -- logs/frames-<timestamp>.jsonl
 *
 * With no argument it picks the most recent log in logs/.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { paths } from '../config.js';
import { SpikeAnalyzer } from './analyzer.js';
import type { ParsedFrame } from '../lib/socketio.js';

function newestLog(): string | undefined {
  if (!fs.existsSync(paths.logsDir)) return undefined;
  const files = fs.readdirSync(paths.logsDir)
    .filter((f) => f.startsWith('frames-') && f.endsWith('.jsonl'))
    .map((f) => path.join(paths.logsDir, f))
    .sort();
  return files.at(-1);
}

async function main() {
  const target = process.argv[2] ?? newestLog();
  if (!target || !fs.existsSync(target)) {
    console.error('No frame log found. Pass a path:  npm run analyze -- logs/frames-....jsonl');
    process.exit(1);
  }
  console.log(`Analyzing ${target}\n`);

  const analyzer = new SpikeAnalyzer();
  const rl = readline.createInterface({ input: fs.createReadStream(target), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line); } catch { continue; }
    // Reconstruct just enough of a ParsedFrame for the analyzer.
    const frame: ParsedFrame = {
      raw: '',
      engineType: rec.engineType as number | undefined,
      socketType: rec.socketType as number | undefined,
      namespace: rec.namespace as string | undefined,
      event: rec.event as string | undefined,
      args: rec.args as unknown[] | undefined,
      json: rec.event !== undefined ? rec.args : undefined,
      heartbeat: rec.event === undefined && rec.args === undefined && rec.raw === undefined,
    };
    analyzer.add(frame);
  }

  console.log(analyzer.report());
}

main().catch((err) => {
  console.error('Analyze failed:', err);
  process.exit(1);
});

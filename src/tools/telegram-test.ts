/**
 * Sends one test alert to Telegram to verify TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.
 * Run:  npm run test:telegram
 */
import { config } from '../config.js';
import { TelegramSender, formatAlert } from '../lib/telegram.js';

async function main() {
  const tg = new TelegramSender(config.telegram.token, config.telegram.chatId);
  if (!tg.isEnabled) {
    console.error('Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
    process.exit(1);
  }

  const sample = formatAlert(
    {
      symbol: 'EURUSD_otc',
      colour: 'red',
      count: config.streakThreshold,
      candle: { symbol: 'EURUSD_otc', periodStart: Math.floor(Date.now() / 1000 / 60) * 60, timeframeSec: config.timeframeSec, open: 1.13072, high: 1.13072, low: 1.13001, close: 1.13011, ticks: 42 },
    },
    config.timeframeSec,
    'EUR/USD OTC',
  );

  const text = `✅ PocketVision test alert\n\n${sample}`;
  console.log('Sending test message…\n');
  console.log(text + '\n');
  const ok = await tg.send(text);
  console.log(ok ? '✓ Sent — check your Telegram.' : '✗ Failed — check token/chat id above.');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

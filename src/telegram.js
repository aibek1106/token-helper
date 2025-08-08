const TelegramBot = require('node-telegram-bot-api');

function initBot(token, allowedChatId, handlers) {
  const bot = new TelegramBot(token, { polling: true });
  const must = (msg) => String(msg.chat.id) === String(allowedChatId);

  bot.onText(/^\/start$/, (msg) => {
    if (!must(msg)) return;
    bot.sendMessage(msg.chat.id, 'Готов. Команды: /buy <mint> [sol] [slip_bps], /sell <posId> <percent>, /positions, /status');
  });

  bot.onText(/^\/positions$/, (msg) => { if (!must(msg)) return; handlers.onPositions(msg, bot); });
  bot.onText(/^\/status$/, (msg) => { if (!must(msg)) return; handlers.onStatus(msg, bot); });

  bot.onText(/^\/buy\s+([1-9A-HJ-NP-Za-km-z]{32,44})(?:\s+([\d.]+))?(?:\s+(\d+))?$/, (msg, m) => {
    if (!must(msg)) return;
    const mint = m[1];
    const sol = m[2] ? Number(m[2]) : undefined;
    const slip = m[3] ? Number(m[3]) : undefined;
    handlers.onBuy(msg, bot, { mint, sol, slip });
  });

  bot.onText(/^\/sell\s+(\d+)\s+(\d{1,3})(?:%)?$/, (msg, m) => {
    if (!must(msg)) return;
    const posId = Number(m[1]);
    const pct = Number(m[2]);
    handlers.onSell(msg, bot, { posId, pct });
  });

  bot.on('polling_error', (e) => console.error('TG polling error', e.message));
  return bot;
}

module.exports = { initBot }; 
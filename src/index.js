const { Connection, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const {
  RPC_URL, PRIVATE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  SLIPPAGE_IN_BPS, SLIPPAGE_OUT_BPS, POLL_MS,
  TP1_PCT, TP2_PCT, TP2_SELL_PCT, TRAILING_PCT, STOP_LOSS_PCT,
  DEFAULT_BUY_SOL,
  AUTO_DISCOVERY, AUTO_BUY, AUTO_BUY_SOL, DISCOVERY_SAMPLE_MS,
  DISCOVERY_SOURCE, MIN_LIQUIDITY_SOL, MAX_TAX_BPS, MAX_PAIR_AGE_MIN,
} = require('./config');
const { initBot } = require('./telegram');
const { getQuote, executeSwap } = require('./jupiter');
const { createPosition, getOpenPositions, getPosition, updatePosition, addTrade } = require('./db');
const { evaluateAndAct, WSOL } = require('./strategy');
const { startDiscovery } = require('./discovery');

const connection = new Connection(RPC_URL, 'confirmed');

function saveGeneratedKeypair(keypair) {
  const file = path.resolve(process.cwd(), 'generated-keypair.json');
  try {
    fs.writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey), null, 2));
    logger.info('generated new keypair', { file, pubkey: keypair.publicKey.toBase58() });
  } catch (e) {
    logger.warn('failed to save generated keypair', { error: e.message });
  }
}

function loadKeypair() {
  if (PRIVATE_KEY && PRIVATE_KEY.trim()) {
    try {
      const arr = JSON.parse(PRIVATE_KEY);
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch {
      return Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    }
  }
  const kp = Keypair.generate();
  saveGeneratedKeypair(kp);
  return kp;
}
const wallet = loadKeypair();

function lamports(nSol) { return Math.floor(nSol * 1e9); }

const params = {
  slIn: SLIPPAGE_IN_BPS,
  slOut: SLIPPAGE_OUT_BPS,
  tp1Pct: TP1_PCT,
  tp2Pct: TP2_PCT,
  tp2SellPct: TP2_SELL_PCT,
  trailingPct: TRAILING_PCT,
  stopLossPct: STOP_LOSS_PCT,
  discoverySampleMs: DISCOVERY_SAMPLE_MS,
  minLiquiditySol: MIN_LIQUIDITY_SOL,
  maxPairAgeMin: MAX_PAIR_AGE_MIN,
};

function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }

async function buyToken(mint, solAmount, slipBps) {
  const amount = lamports(solAmount);
  try {
    const quote = await getQuote({ inputMint: WSOL, outputMint: mint, amount, slippageBps: slipBps ?? params.slIn, onlyDirectRoutes: false });
    const sig = await executeSwap({ quote, userKeypair: wallet, connection, asLegacy: false });
    const tokensOut = Number(quote.outAmount);
    const perToken = amount / tokensOut;

    const posId = createPosition({
      tokenMint: mint,
      entryLamportsIn: amount,
      tokensReceived: tokensOut,
      remainingTokens: tokensOut,
      entryTs: Date.now(),
      entryPerTokenLamports: perToken,
      peakPerTokenLamports: perToken,
    });
    addTrade(posId, 'BUY', tokensOut, amount, sig);
    logger.info('BUY executed', { mint, solAmount, posId, sig });
    return { posId, sig, tokensOut, amount };
  } catch (e) {
    const msg = String(e.message || e);
    logger.warn('BUY first attempt failed', { error: msg });
    // Повтор: предпочесть прямой маршрут и legacy
    const quote2 = await getQuote({ inputMint: WSOL, outputMint: mint, amount, slippageBps: (slipBps ?? params.slIn) + 200, preferDirectRoutes: true });
    const sig2 = await executeSwap({ quote: quote2, userKeypair: wallet, connection, asLegacy: true });
    const tokensOut2 = Number(quote2.outAmount);
    const perToken2 = amount / tokensOut2;
    const posId2 = createPosition({
      tokenMint: mint,
      entryLamportsIn: amount,
      tokensReceived: tokensOut2,
      remainingTokens: tokensOut2,
      entryTs: Date.now(),
      entryPerTokenLamports: perToken2,
      peakPerTokenLamports: perToken2,
    });
    addTrade(posId2, 'BUY', tokensOut2, amount, sig2);
    logger.info('BUY executed (retry legacy/direct)', { mint, solAmount, posId: posId2, sig: sig2 });
    return { posId: posId2, sig: sig2, tokensOut: tokensOut2, amount };
  }
}

async function sellPercent(positionId, pct) {
  const position = getPosition(positionId);
  if (!position || position.closed) throw new Error('Позиция не найдена или уже закрыта');
  const tokensToSell = Math.floor(position.remainingTokens * (pct / 100));
  if (tokensToSell < 1) throw new Error('Слишком маленький объем к продаже');
  const quote = await getQuote({ inputMint: position.tokenMint, outputMint: WSOL, amount: tokensToSell, slippageBps: params.slOut });
  const sig = await executeSwap({ quote, userKeypair: wallet, connection });
  addTrade(position.id, 'SELL_MANUAL', tokensToSell, Number(quote.outAmount), sig);
  const remaining = position.remainingTokens - tokensToSell;
  updatePosition({
    id: position.id,
    remainingTokens: remaining,
    peakPerTokenLamports: position.peakPerTokenLamports,
    withdrawnInitial: position.withdrawnInitial,
    tookTp2: position.tookTp2,
    closed: remaining <= 0 ? 1 : position.closed,
  });
  logger.info('SELL manual executed', { positionId, pct, sig });
  return sig;
}

function startMonitor(notify) {
  setInterval(async () => {
    try {
      const opens = getOpenPositions();
      for (const p of opens) {
        try {
          await evaluateAndAct({ position: p, params, wallet, connection, notify: (m) => notify(m) });
        } catch (e) {
          logger.error('monitor: position error', { id: p.id, error: e.message });
          notify(`Ошибка по позиции ${p.id}: ${e.message}`);
        }
      }
    } catch (e) {
      logger.error('monitor: loop error', { error: e.message });
    }
  }, POLL_MS);
}

async function hasBuyRoute(mint) {
  try {
    const testAmount = lamports(0.001); // 0.001 SOL
    await getQuote({ inputMint: WSOL, outputMint: mint, amount: testAmount, slippageBps: params.slIn });
    return true;
  } catch (e) {
    logger.info('candidate: no route', { mint, error: String(e.message || e) });
    return false;
  }
}

function main() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    logger.error('missing telegram config');
    process.exit(1);
  }
  const bot = initBot(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, {
    onPositions: (msg, bot) => {
      const opens = getOpenPositions();
      if (!opens.length) return bot.sendMessage(msg.chat.id, 'Открытых позиций нет');
      const lines = opens.map(p => `#${p.id} mint=${p.tokenMint}\nremain=${p.remainingTokens} tokens\nentry=${(p.entryPerTokenLamports/1e9).toFixed(9)} SOL/токен\npeak=${(p.peakPerTokenLamports/1e9).toFixed(9)} SOL/токен`);
      bot.sendMessage(msg.chat.id, lines.join('\n\n'));
    },
    onStatus: (msg, bot) => {
      bot.sendMessage(msg.chat.id, `Параметры:\nTP1=${fmtPct(params.tp1Pct)} | TP2=${fmtPct(params.tp2Pct)} (sell ${(params.tp2SellPct*100)|0}% )\nTrail=${fmtPct(params.trailingPct)} | SL=${fmtPct(params.stopLossPct)}\nSlip in=${SLIPPAGE_IN_BPS}bps out=${SLIPPAGE_OUT_BPS}bps\nPoll=${(POLL_MS/1000)|0}s\nAuto discovery=${AUTO_DISCOVERY}(${DISCOVERY_SOURCE}) | Auto buy=${AUTO_BUY} (${AUTO_BUY_SOL} SOL)\nFilters: liq>=${params.minLiquiditySol} SOL, age<=${params.maxPairAgeMin}m\nDefault buy=${DEFAULT_BUY_SOL} SOL`);
    },
    onBuy: async (msg, bot, { mint, sol, slip }) => {
      bot.sendChatAction(msg.chat.id, 'typing');
      const solAmt = sol ?? DEFAULT_BUY_SOL;
      try {
        const { posId, sig, tokensOut } = await buyToken(mint, solAmt, slip);
        bot.sendMessage(msg.chat.id, `BUY OK: pos #${posId}\n${solAmt} SOL -> ${tokensOut} токенов\nsig=${sig}`);
      } catch (e) {
        logger.error('BUY error', { error: e.message });
        bot.sendMessage(msg.chat.id, `BUY error: ${e.message}`);
      }
    },
    onSell: async (msg, bot, { posId, pct }) => {
      bot.sendChatAction(msg.chat.id, 'typing');
      try {
        const sig = await sellPercent(posId, pct);
        bot.sendMessage(msg.chat.id, `SELL ${pct}% OK: pos #${posId}\nsig=${sig}`);
      } catch (e) {
        logger.error('SELL error', { error: e.message });
        bot.sendMessage(msg.chat.id, `SELL error: ${e.message}`);
      }
    },
  });

  const notify = (m) => bot.sendMessage(TELEGRAM_CHAT_ID, m);
  logger.info('bot started', { rpc: RPC_URL, autoDiscovery: AUTO_DISCOVERY, autoBuy: AUTO_BUY });
  notify('Бот запущен. Используйте /buy, /sell, /positions, /status');
  notify(`Публичный ключ кошелька: ${wallet.publicKey.toBase58()}`);
  if (AUTO_DISCOVERY) {
    startDiscovery({
      connection,
      params,
      onCandidate: async ({ mint, source, reason }) => {
        if (!(await hasBuyRoute(mint))) {
          logger.info('discovery: candidate skipped (no route)', { mint, source });
          return;
        }
        logger.info('discovery: candidate notify', { mint, source, reason });
        notify(`Найден кандидат: ${mint} (source=${source}, reason=${reason})`);
        if (AUTO_BUY) {
          try {
            const { posId, sig } = await buyToken(mint, AUTO_BUY_SOL, SLIPPAGE_IN_BPS);
            logger.info('AUTO BUY executed', { mint, posId, sig });
            notify(`AUTO BUY OK: pos #${posId}, tx ${sig}`);
          } catch (e) {
            logger.error('AUTO BUY error', { error: e.message, mint });
            notify(`AUTO BUY error (${mint}): ${e.message}`);
          }
        }
      },
      source: DISCOVERY_SOURCE,
    });
  }
  startMonitor(notify);
}

main(); 

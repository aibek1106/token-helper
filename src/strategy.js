const { getQuote, executeSwap } = require('./jupiter');
const { updatePosition, addTrade } = require('./db');
const logger = require('./logger');
const { getOnChainTokenBalance } = require('./solanaHelpers');

const WSOL = 'So11111111111111111111111111111111111111112';

function applyFeeBuffer(amount) {
  const buffered = Math.floor(amount * 0.985);
  return Math.max(1, Math.min(amount, buffered));
}

async function syncRemainingWithOnChain({ connection, wallet, position }) {
  try {
    const onChain = await getOnChainTokenBalance(connection, wallet.publicKey, position.tokenMint);
    if (onChain >= 0 && onChain !== position.remainingTokens) {
      logger.info('sync remaining with on-chain', { posId: position.id, prev: position.remainingTokens, onChain });
      position.remainingTokens = onChain;
    }
  } catch (e) {
    logger.warn('sync remaining failed', { posId: position.id, error: e.message });
  }
}

async function quoteAndSwap({
  inputMint,
  outputMint,
  amount,
  slippageBps,
  wallet,
  connection,
  computeUnitPriceMicroLamports = 150000,
  preferDirect = false,
}) {
  const quote = await getQuote({ inputMint, outputMint, amount, slippageBps, onlyDirectRoutes: preferDirect, preferDirectRoutes: preferDirect });
  const sig = await executeSwap({ quote, userKeypair: wallet, connection, computeUnitPriceMicroLamports });
  return { sig, outAmount: Number(quote.outAmount) };
}

async function trySellWithRetry({ inputMint, outputMint, amount, baseSlippageBps, wallet, connection, notify, label, boostForLabel = 300 }) {
  const safeAmount = applyFeeBuffer(amount);
  try {
    logger.info('sell attempt 1', { label, amount: safeAmount, slippageBps: baseSlippageBps });
    return await quoteAndSwap({ inputMint, outputMint, amount: safeAmount, slippageBps: baseSlippageBps, wallet, connection, computeUnitPriceMicroLamports: 150000, preferDirect: false });
  } catch (e) {
    const msg = String(e.message || e);
    logger.warn('sell attempt 1 failed', { label, error: msg });
    if (notify) notify(`${label}: попытка 1 не удалась (${msg}). Пробую с бОльшим слиппеджем/прямым маршрутом...`);
  }
  try {
    const slOut = baseSlippageBps + boostForLabel;
    logger.info('sell attempt 2', { label, amount: safeAmount, slippageBps: slOut, direct: true });
    return await quoteAndSwap({ inputMint, outputMint, amount: safeAmount, slippageBps: slOut, wallet, connection, computeUnitPriceMicroLamports: 350000, preferDirect: true });
  } catch (e2) {
    const msg2 = String(e2.message || e2);
    logger.error('sell attempt 2 failed', { label, error: msg2 });
    if (notify) notify(`${label}: попытка 2 не удалась (${msg2}). Сделка отменена.`);
    throw e2;
  }
}

async function evaluateAndAct({ position, params, wallet, connection, notify }) {
  if (position.closed) return;

  await syncRemainingWithOnChain({ connection, wallet, position });

  let sampleTokens = Math.floor(position.remainingTokens * 0.1);
  if (sampleTokens < 1) sampleTokens = position.remainingTokens;

  const q = await getQuote({
    inputMint: position.tokenMint,
    outputMint: WSOL,
    amount: sampleTokens,
    slippageBps: params.slOut,
  });
  const perTokenNow = Number(q.outAmount) / sampleTokens;

  let peak = Math.max(position.peakPerTokenLamports, perTokenNow);
  const gain = perTokenNow / position.entryPerTokenLamports - 1;

  let withdrawnInitial = position.withdrawnInitial;
  let tookTp2 = position.tookTp2;
  let remaining = position.remainingTokens;
  let closed = position.closed;

  // TP1
  if (!withdrawnInitial && gain >= params.tp1Pct && remaining > 0) {
    let tokensToSell = Math.min(
      remaining,
      Math.ceil(position.entryLamportsIn / perTokenNow)
    );
    tokensToSell = Math.min(tokensToSell, Math.max(1, remaining - 1));
    if (tokensToSell > 0) {
      try {
        const { sig, outAmount } = await trySellWithRetry({
          inputMint: position.tokenMint,
          outputMint: WSOL,
          amount: tokensToSell,
          baseSlippageBps: params.slOut,
          wallet,
          connection,
          notify,
          label: 'TP1',
          boostForLabel: 300,
        });
        addTrade(position.id, 'SELL_TP1', tokensToSell, outAmount, sig);
        remaining -= tokensToSell;
        withdrawnInitial = 1;
        notify(`TP1: вернул первоначалку. pos ${position.id}, tx ${sig}`);
      } catch (_) { return; }
    }
  }

  // TP2
  if (withdrawnInitial && !tookTp2 && gain >= params.tp2Pct && remaining > 0) {
    let tokensToSell = Math.floor(remaining * params.tp2SellPct);
    tokensToSell = Math.min(tokensToSell, Math.max(1, remaining - 1));
    if (tokensToSell > 0) {
      try {
        const { sig, outAmount } = await trySellWithRetry({
          inputMint: position.tokenMint,
          outputMint: WSOL,
          amount: tokensToSell,
          baseSlippageBps: params.slOut,
          wallet,
          connection,
          notify,
          label: 'TP2',
          boostForLabel: 400,
        });
        addTrade(position.id, 'SELL_TP2', tokensToSell, outAmount, sig);
        remaining -= tokensToSell;
        tookTp2 = 1;
        notify(`TP2: продал часть. pos ${position.id}, tx ${sig}`);
      } catch (_) { return; }
    }
  }

  // Trailing
  if (perTokenNow > peak) peak = perTokenNow;
  const trailCut = peak * (1 - params.trailingPct);
  if (remaining > 0 && perTokenNow <= trailCut && gain > 0) {
    let tokensToSell = Math.max(1, remaining - 1);
    try {
      const { sig, outAmount } = await trySellWithRetry({
        inputMint: position.tokenMint,
        outputMint: WSOL,
        amount: tokensToSell,
        baseSlippageBps: params.slOut,
        wallet,
        connection,
        notify,
        label: 'Trailing',
        boostForLabel: 600,
      });
      addTrade(position.id, 'SELL_TRAIL', tokensToSell, outAmount, sig);
      remaining = 0;
      closed = 1;
      notify(`Trailing Stop: закрыл позицию. pos ${position.id}, tx ${sig}`);
    } catch (_) { return; }
  }

  // Stop-Loss
  if (!closed && remaining > 0) {
    const stop = position.entryPerTokenLamports * (1 - params.stopLossPct);
    if (perTokenNow <= stop) {
      let tokensToSell = Math.max(1, remaining - 1);
      try {
        const { sig, outAmount } = await trySellWithRetry({
          inputMint: position.tokenMint,
          outputMint: WSOL,
          amount: tokensToSell,
          baseSlippageBps: params.slOut,
          wallet,
          connection,
          notify,
          label: 'Stop-Loss',
          boostForLabel: 700,
        });
        addTrade(position.id, 'SELL_SL', tokensToSell, outAmount, sig);
        remaining = 0;
        closed = 1;
        notify(`Stop Loss: закрыл позицию. pos ${position.id}, tx ${sig}`);
      } catch (_) { return; }
    }
  }

  updatePosition({
    id: position.id,
    remainingTokens: remaining,
    peakPerTokenLamports: peak,
    withdrawnInitial,
    tookTp2,
    closed,
  });
}

module.exports = { evaluateAndAct, WSOL }; 

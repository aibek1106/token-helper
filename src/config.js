require('dotenv').config();

function num(name, def) {
  const v = process.env[name];
  return v !== undefined ? Number(v) : def;
}
function bool(name, def) {
  const v = process.env[name];
  if (v === undefined) return def;
  return ['1','true','yes','on'].includes(String(v).toLowerCase());
}
function str(name, def) {
  const v = process.env[name];
  return v !== undefined ? String(v) : def;
}
function list(name, defCsv) {
  const v = process.env[name];
  const raw = v !== undefined ? String(v) : defCsv;
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

module.exports = {
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  SLIPPAGE_IN_BPS: num('SLIPPAGE_IN_BPS', 500),
  SLIPPAGE_OUT_BPS: num('SLIPPAGE_OUT_BPS', 700),
  POLL_MS: num('POLL_MS', 15000),
  TP1_PCT: num('TP1_PCT', 0.5),
  TP2_PCT: num('TP2_PCT', 1.0),
  TP2_SELL_PCT: num('TP2_SELL_PCT', 0.5),
  TRAILING_PCT: num('TRAILING_PCT', 0.25),
  STOP_LOSS_PCT: num('STOP_LOSS_PCT', 0.25),
  DEFAULT_BUY_SOL: num('DEFAULT_BUY_SOL', 0.05),

  // Авто-режим
  AUTO_DISCOVERY: bool('AUTO_DISCOVERY', false),
  AUTO_BUY: bool('AUTO_BUY', false),
  AUTO_BUY_SOL: num('AUTO_BUY_SOL', 0.01),
  DISCOVERY_SAMPLE_MS: num('DISCOVERY_SAMPLE_MS', 5000),
  DISCOVERY_SOURCE: str('DISCOVERY_SOURCE', 'dexscreener'), // dexscreener | gecko | multi | onchain_stub
  MAX_PAIR_AGE_MIN: num('MAX_PAIR_AGE_MIN', 1000000),
  MIN_PAIR_AGE_MIN: num('MIN_PAIR_AGE_MIN', 0),
  DEBUG_DISCOVERY: bool('DEBUG_DISCOVERY', false),

  // Фильтры (по ликвидности и т.п.)
  MIN_LIQUIDITY_SOL: num('MIN_LIQUIDITY_SOL', 3),
  MAX_TAX_BPS: num('MAX_TAX_BPS', 1500),
  MIN_LIQUIDITY_USD: num('MIN_LIQUIDITY_USD', 100),
  MIN_VOLUME_H24_USD: num('MIN_VOLUME_H24_USD', 100),
  MIN_TXNS_M5: num('MIN_TXNS_M5', 0),
  MAX_FDV_USD: num('MAX_FDV_USD', 1000000000),

  // Белые списки ликвидных активов
  ALLOWED_SYMBOLS: list('ALLOWED_SYMBOLS', 'BONK,PUMP,SOL,USDC,USDT,JUP,JITO,RAY,WIF'),
  ALLOWED_MINTS: list('ALLOWED_MINTS', ''),

  // Dexscreener search query
  DEXSCREENER_QUERY: str('DEXSCREENER_QUERY', 'chain:solana new|chain:solana wsol|chain:solana raydium'),
  SEEN_TTL_MIN: num('SEEN_TTL_MIN', 120),
} 
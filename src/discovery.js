const fetch = require('node-fetch');
const { wasSeenMint, markSeenMint } = require('./db');
const logger = require('./logger');
const { DEBUG_DISCOVERY, DEXSCREENER_QUERY, MIN_LIQUIDITY_USD, MIN_VOLUME_H24_USD, MIN_TXNS_M5, MAX_FDV_USD, MIN_PAIR_AGE_MIN, ALLOWED_SYMBOLS, ALLOWED_MINTS } = require('./config');

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    timeout: 10000,
    headers: {
      'User-Agent': 'token-helper/1.0',
      'Accept': 'application/json',
      ...headers,
    },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function fetchDexScreenerSearch(query) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
  const data = await fetchJson(url);
  const pairs = Array.isArray(data.pairs) ? data.pairs : [];
  return pairs.filter(p => p.chainId === 'solana');
}

function toMinutes(ms) { return ms / 60000; }

function isSolLikeAddress(addr) {
  return addr === 'So11111111111111111111111111111111111111112';
}

function pickMintFromPair(pair) {
  const { baseToken, quoteToken, baseSymbol = '', quoteSymbol = '' } = pair;
  if (!baseToken || !quoteToken) return { mint: null, reason: 'no-tokens' };

  const baseIsSol = isSolLikeAddress(baseToken.address) || /\b(w?sol)\b/i.test(baseSymbol);
  const quoteIsSol = isSolLikeAddress(quoteToken.address) || /\b(w?sol)\b/i.test(quoteSymbol);

  if (baseIsSol && !quoteIsSol) return { mint: quoteToken.address, reason: 'SOL as base' };
  if (quoteIsSol && !baseIsSol) return { mint: baseToken.address, reason: 'SOL as quote' };

  return { mint: null, reason: 'no-sol-side' };
}

function normalizeMint(m) {
  if (!m) return m;
  if (typeof m === 'string' && m.startsWith('solana_')) return m.slice('solana_'.length);
  return m;
}

function pickMintFromGecko(pool) {
  const name = pool?.attributes?.name || '';
  const parts = name.split('/').map(s => s.trim().toUpperCase());
  const [left, right] = parts;
  const hasSolLeft = /(WSOL|SOL)/.test(left || '');
  const hasSolRight = /(WSOL|SOL)/.test(right || '');

  let baseMint = pool?.relationships?.base_token?.data?.id || pool?.attributes?.base_token_address || pool?.attributes?.base_token_id;
  let quoteMint = pool?.relationships?.quote_token?.data?.id || pool?.attributes?.quote_token_address || pool?.attributes?.quote_token_id;

  baseMint = normalizeMint(baseMint);
  quoteMint = normalizeMint(quoteMint);

  if (hasSolLeft && !hasSolRight && quoteMint) return { mint: quoteMint, reason: 'SOL as base (left)' };
  if (hasSolRight && !hasSolLeft && baseMint) return { mint: baseMint, reason: 'SOL as quote (right)' };
  return { mint: null, reason: 'no-sol-side' };
}

async function fetchGeckoNewPools() {
  const candidates = [
    'https://api.geckoterminal.com/api/v2/onchain/networks/solana/new_pools?page=1',
    'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1',
    'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1',
  ];
  let lastErr;
  for (const url of candidates) {
    try {
      const data = await fetchJson(url);
      const pools = Array.isArray(data.data) ? data.data : [];
      if (pools.length) return pools.map(p => ({
        raw: p,
        reserveUsd: p?.attributes?.reserve_in_usd || 0,
        fdvUsd: p?.attributes?.fdv_usd || 0,
        volumeUsd24h: p?.attributes?.volume_usd_24h || 0,
        name: p?.attributes?.name || '',
        createdAt: p?.attributes?.created_at || null,
      }));
      // даже если пусто — вернуть пустой массив
      return [];
    } catch (e) {
      lastErr = e;
      if (DEBUG_DISCOVERY) logger.warn('gecko endpoint failed', { url, error: e.message });
      continue;
    }
  }
  throw lastErr || new Error('all gecko endpoints failed');
}

async function startDiscovery({ connection, params, onCandidate, source = 'dexscreener' }) {
  if (source === 'onchain_stub') {
    setInterval(async () => {
      try {
        const fakeMint = 'FAKE_MINT_' + Math.floor(Math.random()*1e6);
        if (wasSeenMint(fakeMint)) return;
        markSeenMint(fakeMint);
        logger.info('discovery: stub candidate', { mint: fakeMint });
        await onCandidate({ mint: fakeMint, source: 'stub', reason: 'discovery-stub' });
      } catch (e) {
        logger.error('discovery: stub error', { error: e.message });
      }
    }, params.discoverySampleMs);
    return;
  }

  const runDexscreener = async () => {
    const queries = String(DEXSCREENER_QUERY || '').split('|').map(q => q.trim()).filter(Boolean);
    const now = Date.now();
    const all = [];
    for (const q of (queries.length ? queries : ['chain:solana new'])) {
      try {
        const pairs = await fetchDexScreenerSearch(q);
        logger.info('discovery: search endpoint', { count: pairs.length, query: q });
        all.push(...pairs);
      } catch (e) {
        logger.warn('discovery: search query error', { query: q, error: e.message });
      }
    }
    const byPair = new Map();
    for (const p of all) { if (p.pairAddress) byPair.set(p.pairAddress, p); }
    const uniq = Array.from(byPair.values());
    uniq.sort((a, b) => {
      const ageA = a.pairCreatedAt ? (now - a.pairCreatedAt) : Number.MAX_SAFE_INTEGER;
      const ageB = b.pairCreatedAt ? (now - b.pairCreatedAt) : Number.MAX_SAFE_INTEGER;
      return ageA - ageB;
    });

    for (const p of uniq) {
      try {
        const ageMin = p.pairCreatedAt ? toMinutes(now - p.pairCreatedAt) : null;
        if (ageMin !== null) {
          if (ageMin > (params.maxPairAgeMin || 15)) { if (DEBUG_DISCOVERY) logger.info('skip: ageMax', { ageMin }); continue; }
          if (ageMin < (MIN_PAIR_AGE_MIN || 0)) { if (DEBUG_DISCOVERY) logger.info('skip: ageMin', { ageMin }); continue; }
        }

        const liquidityUsd = p.liquidity?.usd || 0;
        if (liquidityUsd && liquidityUsd < MIN_LIQUIDITY_USD) { if (DEBUG_DISCOVERY) logger.info('skip: liqUsd', { liquidityUsd }); continue; }

        const volH24 = p.volume?.h24 || 0;
        if (volH24 && volH24 < MIN_VOLUME_H24_USD) { if (DEBUG_DISCOVERY) logger.info('skip: volH24', { volH24 }); continue; }

        const txm5 = (p.txns?.m5?.buys || 0) + (p.txns?.m5?.sells || 0);
        if (txm5 < MIN_TXNS_M5) { if (DEBUG_DISCOVERY) logger.info('skip: txm5', { txm5 }); continue; }

        const fdv = p.fdv || 0;
        if (fdv && fdv > MAX_FDV_USD) { if (DEBUG_DISCOVERY) logger.info('skip: fdv', { fdv }); continue; }

        const pick = pickMintFromPair(p);
        if (!pick.mint) { if (DEBUG_DISCOVERY) logger.info('skip: no mint from pair', { reason: pick.reason }); continue; }
        // Белый список по символам/минамтам (проверяем обе стороны пары)
        const baseSym = (p.baseToken?.symbol || '').toUpperCase();
        const quoteSym = (p.quoteToken?.symbol || '').toUpperCase();
        if (ALLOWED_MINTS.length && !ALLOWED_MINTS.includes(pick.mint)) { if (DEBUG_DISCOVERY) logger.info('skip: not in allowed mints'); continue; }
        if (ALLOWED_SYMBOLS.length) {
          const symAllowed = (baseSym && ALLOWED_SYMBOLS.includes(baseSym)) || (quoteSym && ALLOWED_SYMBOLS.includes(quoteSym));
          if (!symAllowed) { if (DEBUG_DISCOVERY) logger.info('skip: not in allowed symbols', { baseSym, quoteSym }); continue; }
        }
        if (wasSeenMint(pick.mint)) { if (DEBUG_DISCOVERY) logger.info('skip: seen'); continue; }

        markSeenMint(pick.mint);
        logger.info('discovery: candidate', { mint: pick.mint, liquidityUsd, volH24, txm5, fdv, ageMin });
        await onCandidate({
          mint: pick.mint,
          source: 'dexscreener',
          reason: `filters: age=[${MIN_PAIR_AGE_MIN}-${params.maxPairAgeMin}]m liqUsd>=${MIN_LIQUIDITY_USD} vol24h>=${MIN_VOLUME_H24_USD} txm5>=${MIN_TXNS_M5} fdv<=${MAX_FDV_USD}`,
        });
      } catch (e) {
        logger.warn('discovery: pair processing error', { error: e.message });
      }
    }
  };

  const runGecko = async () => {
    try {
      const pools = await fetchGeckoNewPools();
      logger.info('discovery: gecko pools', { count: pools.length });
      for (const pool of pools) {
        try {
          const reserveUsd = Number(pool.reserveUsd || 0);
          if (reserveUsd && reserveUsd < MIN_LIQUIDITY_USD) { if (DEBUG_DISCOVERY) logger.info('skip: liqUsd', { liquidityUsd: reserveUsd }); continue; }

          const volH24 = Number(pool.volumeUsd24h || 0);
          if (volH24 && volH24 < MIN_VOLUME_H24_USD) { if (DEBUG_DISCOVERY) logger.info('skip: volH24', { volH24 }); continue; }

          const fdv = Number(pool.fdvUsd || 0);
          if (fdv && fdv > MAX_FDV_USD) { if (DEBUG_DISCOVERY) logger.info('skip: fdv', { fdv }); continue; }

          const pick = pickMintFromGecko(pool.raw);
          if (!pick.mint) { if (DEBUG_DISCOVERY) logger.info('skip: no mint from gecko', { reason: pick.reason, name: pool.name }); continue; }
          // Белый список: извлекаем символ токена (не SOL) из имени "TOKEN / SOL" или "SOL / TOKEN"
          const name = pool.name || '';
          const parts = name.split('/').map(s => s.trim().toUpperCase());
          const left = parts[0] || '';
          const right = parts[1] || '';
          const tokenSym = /(WSOL|SOL)/.test(left) ? right : left;
          if (ALLOWED_MINTS.length && !ALLOWED_MINTS.includes(pick.mint)) { if (DEBUG_DISCOVERY) logger.info('skip: not in allowed mints'); continue; }
          if (ALLOWED_SYMBOLS.length && tokenSym && !ALLOWED_SYMBOLS.includes(tokenSym)) { if (DEBUG_DISCOVERY) logger.info('skip: not in allowed symbols', { tokenSym }); continue; }
          if (wasSeenMint(pick.mint)) { if (DEBUG_DISCOVERY) logger.info('skip: seen'); continue; }

          markSeenMint(pick.mint);
          logger.info('discovery: candidate', { mint: pick.mint, liquidityUsd: reserveUsd, volH24, fdv, source: 'gecko' });
          await onCandidate({ mint: pick.mint, source: 'gecko', reason: `gecko filters: liqUsd>=${MIN_LIQUIDITY_USD} vol24h>=${MIN_VOLUME_H24_USD} fdv<=${MAX_FDV_USD}` });
        } catch (e) {
          logger.warn('discovery: gecko pool error', { error: e.message });
        }
      }
    } catch (e) {
      logger.error('discovery: gecko error', { error: e.message });
    }
  };

  if (source === 'dexscreener') {
    setInterval(runDexscreener, params.discoverySampleMs);
    return;
  }
  if (source === 'gecko') {
    setInterval(runGecko, params.discoverySampleMs);
    return;
  }
  if (source === 'multi') {
    setInterval(() => { runDexscreener(); runGecko(); }, params.discoverySampleMs);
    return;
  }
}

module.exports = { startDiscovery };

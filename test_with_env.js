// Set environment variables - очень ослабленные фильтры
process.env.MAX_PAIR_AGE_MIN = '1000000'; // ~2 года
process.env.MIN_LIQUIDITY_USD = '100';
process.env.MIN_VOLUME_H24_USD = '100';
process.env.MIN_TXNS_M5 = '0';
process.env.MAX_FDV_USD = '1000000000';

console.log('=== Environment Variables ===');
console.log('MAX_PAIR_AGE_MIN env:', process.env.MAX_PAIR_AGE_MIN);
console.log('MIN_LIQUIDITY_USD env:', process.env.MIN_LIQUIDITY_USD);
console.log('MIN_VOLUME_H24_USD env:', process.env.MIN_VOLUME_H24_USD);
console.log('MIN_TXNS_M5 env:', process.env.MIN_TXNS_M5);
console.log('MAX_FDV_USD env:', process.env.MAX_FDV_USD);

// Clear require cache
delete require.cache[require.resolve('./src/config.js')];

const config = require('./src/config');

console.log('\n=== Testing Filters Configuration ===');
console.log('MAX_PAIR_AGE_MIN:', config.MAX_PAIR_AGE_MIN, 'minutes');
console.log('MIN_LIQUIDITY_USD:', config.MIN_LIQUIDITY_USD);
console.log('MIN_VOLUME_H24_USD:', config.MIN_VOLUME_H24_USD);
console.log('MIN_TXNS_M5:', config.MIN_TXNS_M5);
console.log('MAX_FDV_USD:', config.MAX_FDV_USD);
console.log('DEXSCREENER_QUERY:', config.DEXSCREENER_QUERY);

// Test with sample data from logs
const samplePairs = [
  {
    pairAddress: '37iWFSqgnTSAfShoBTBzQghwsTtkWAZW3yVzgJWKn6iK',
    pairCreatedAt: Date.now() - (143909.6429 * 60000), // 143909 minutes old
    liquidity: { usd: 1073339.26 },
    volume: { h24: 979566.65 },
    txns: { m5: { buys: 5, sells: 4 } },
    fdv: 8459183,
    baseToken: { address: '38PgzpJYu2HkiYvV8qePFakB8tuobPdGm2FFEn7Dpump' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112' }
  },
  {
    pairAddress: '4zEnTv87pNewgKVcGr6gGaumxzV3xMCPghA927nkaNtu',
    pairCreatedAt: Date.now() - (133201.40956666667 * 60000), // 133201 minutes old
    liquidity: { usd: 1970983.86 },
    volume: { h24: 212284.54 },
    txns: { m5: { buys: 0, sells: 0 } },
    fdv: 28804724,
    baseToken: { address: '4Uf883orBx89VQZiV4EoRpNqUWYN5ZuEvC4PCpQ9moon' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112' }
  }
];

console.log('\n=== Testing Sample Pairs ===');
const now = Date.now();

samplePairs.forEach((p, i) => {
  const age = p.pairCreatedAt ? (now - p.pairCreatedAt) / 60000 : null;
  const liquidityUsd = p.liquidity?.usd || 0;
  const volH24 = p.volume?.h24 || 0;
  const txm5 = (p.txns?.m5?.buys || 0) + (p.txns?.m5?.sells || 0);
  const fdv = p.fdv || 0;
  
  console.log(`\nPair ${i + 1}:`);
  console.log('  ageMin:', age ? age.toFixed(2) : 'null');
  console.log('  liquidityUsd:', liquidityUsd);
  console.log('  volH24:', volH24);
  console.log('  txm5:', txm5);
  console.log('  fdv:', fdv);
  
  let skipReason = null;
  
  if (age !== null) {
    if (age > config.MAX_PAIR_AGE_MIN) skipReason = `ageMax: ${age.toFixed(2)}`;
    else if (age < config.MIN_PAIR_AGE_MIN) skipReason = `ageMin: ${age.toFixed(2)}`;
  }
  
  if (!skipReason && liquidityUsd < config.MIN_LIQUIDITY_USD) skipReason = `liqUsd: ${liquidityUsd}`;
  if (!skipReason && volH24 < config.MIN_VOLUME_H24_USD) skipReason = `volH24: ${volH24}`;
  if (!skipReason && txm5 < config.MIN_TXNS_M5) skipReason = `txm5: ${txm5}`;
  if (!skipReason && fdv > config.MAX_FDV_USD) skipReason = `fdv: ${fdv}`;
  
  if (skipReason) {
    console.log('  ❌ Skip:', skipReason);
  } else {
    console.log('  ✅ Passes filters');
  }
});

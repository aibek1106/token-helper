// Set environment variables for testing
process.env.MAX_PAIR_AGE_MIN = '1000000';
process.env.MIN_LIQUIDITY_USD = '100';
process.env.MIN_VOLUME_H24_USD = '100';
process.env.MIN_TXNS_M5 = '0';
process.env.MAX_FDV_USD = '1000000000';
process.env.AUTO_DISCOVERY = 'true';
process.env.DEBUG_DISCOVERY = 'true';
process.env.DISCOVERY_SAMPLE_MS = '5000';

console.log('=== Starting bot with relaxed filters ===');
console.log('MAX_PAIR_AGE_MIN:', process.env.MAX_PAIR_AGE_MIN);
console.log('MIN_LIQUIDITY_USD:', process.env.MIN_LIQUIDITY_USD);
console.log('MIN_VOLUME_H24_USD:', process.env.MIN_VOLUME_H24_USD);
console.log('MIN_TXNS_M5:', process.env.MIN_TXNS_M5);
console.log('MAX_FDV_USD:', process.env.MAX_FDV_USD);

// Start the bot
require('./src/index.js');

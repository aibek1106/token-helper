console.log('=== Debug Config Loading ===');

// Clear require cache
delete require.cache[require.resolve('./src/config.js')];

const config = require('./src/config');

console.log('Config object:', JSON.stringify(config, null, 2));

// Check specific values
console.log('\n=== Specific Values ===');
console.log('MAX_PAIR_AGE_MIN:', config.MAX_PAIR_AGE_MIN, typeof config.MAX_PAIR_AGE_MIN);
console.log('MIN_LIQUIDITY_USD:', config.MIN_LIQUIDITY_USD, typeof config.MIN_LIQUIDITY_USD);
console.log('MIN_VOLUME_H24_USD:', config.MIN_VOLUME_H24_USD, typeof config.MIN_VOLUME_H24_USD);
console.log('MIN_TXNS_M5:', config.MIN_TXNS_M5, typeof config.MIN_TXNS_M5);
console.log('MAX_FDV_USD:', config.MAX_FDV_USD, typeof config.MAX_FDV_USD);

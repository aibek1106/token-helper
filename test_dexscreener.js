const fetch = require('node-fetch');

async function testDexScreener() {
  const queries = [
    'chain:solana new',
    'chain:solana wsol',
    'chain:solana raydium',
    'chain:solana',
    'solana new',
    'new solana'
  ];
  
  for (const q of queries) {
    try {
      console.log(`\n=== Testing query: "${q}" ===`);
      const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;
      
      const r = await fetch(url);
      const d = await r.json();
      const pairs = (d.pairs || []).filter(p => p.chainId === 'solana');
      
      console.log('Total pairs:', pairs.length);
      const now = Date.now();
      
      // Find youngest pairs
      const sortedPairs = pairs
        .filter(p => p.pairCreatedAt)
        .sort((a, b) => b.pairCreatedAt - a.pairCreatedAt)
        .slice(0, 3);
      
      sortedPairs.forEach((p, i) => {
        const age = (now - p.pairCreatedAt) / 60000;
        console.log(`\nYoungest pair ${i + 1}:`);
        console.log('  pairAddress:', p.pairAddress);
        console.log('  ageMin:', age.toFixed(2));
        console.log('  liquidityUsd:', p.liquidity?.usd);
        console.log('  volH24:', p.volume?.h24);
        console.log('  txm5:', (p.txns?.m5?.buys || 0) + (p.txns?.m5?.sells || 0));
        console.log('  fdv:', p.fdv);
        console.log('  baseToken:', p.baseToken?.address);
        console.log('  quoteToken:', p.quoteToken?.address);
      });
      
      // Test with relaxed filters
      console.log('\n--- Testing with relaxed filters ---');
      const MIN_LIQUIDITY_USD = 1000; // Lowered
      const MIN_VOLUME_H24_USD = 1000; // Lowered
      const MIN_TXNS_M5 = 1; // Lowered
      const MAX_FDV_USD = 100000000; // Increased
      const MAX_PAIR_AGE_MIN = 1440; // 24 hours
      const MIN_PAIR_AGE_MIN = 0;
      
      let passedFilters = 0;
      pairs.forEach((p, i) => {
        const age = p.pairCreatedAt ? (now - p.pairCreatedAt) / 60000 : null;
        const liquidityUsd = p.liquidity?.usd || 0;
        const volH24 = p.volume?.h24 || 0;
        const txm5 = (p.txns?.m5?.buys || 0) + (p.txns?.m5?.sells || 0);
        const fdv = p.fdv || 0;
        
        let skipReason = null;
        
        if (age !== null) {
          if (age > MAX_PAIR_AGE_MIN) skipReason = `ageMax: ${age.toFixed(2)}`;
          else if (age < MIN_PAIR_AGE_MIN) skipReason = `ageMin: ${age.toFixed(2)}`;
        }
        
        if (!skipReason && liquidityUsd < MIN_LIQUIDITY_USD) skipReason = `liqUsd: ${liquidityUsd}`;
        if (!skipReason && volH24 < MIN_VOLUME_H24_USD) skipReason = `volH24: ${volH24}`;
        if (!skipReason && txm5 < MIN_TXNS_M5) skipReason = `txm5: ${txm5}`;
        if (!skipReason && fdv > MAX_FDV_USD) skipReason = `fdv: ${fdv}`;
        
        if (!skipReason) {
          passedFilters++;
          console.log(`\n✅ Candidate ${passedFilters}:`, {
            pairAddress: p.pairAddress,
            ageMin: age ? age.toFixed(2) : null,
            liquidityUsd,
            volH24,
            txm5,
            fdv
          });
        }
      });
      
      console.log(`Results: ${passedFilters}/${pairs.length} pairs passed relaxed filters`);
      
    } catch (e) {
      console.error(`Error with query "${q}":`, e.message);
    }
  }
}

testDexScreener();

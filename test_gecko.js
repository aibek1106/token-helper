const fetch = require('node-fetch');

async function testGecko() {
  const url = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1';
  try {
    const r = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'token-helper/1.0'
      },
      timeout: 10000,
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`${r.status} ${t}`);
    }
    const data = await r.json();
    const pools = Array.isArray(data.data) ? data.data : [];
    console.log('Total pools:', pools.length);
    pools.slice(0, 5).forEach((p, i) => {
      const attrs = p.attributes || {};
      console.log(`\nPool ${i + 1}:`);
      console.log('  address:', attrs.address);
      console.log('  name:', attrs.name);
      console.log('  dex:', attrs.dex || attrs.dex_name);
      console.log('  created_at:', attrs.created_at);
      console.log('  base_token_id:', attrs.base_token_id);
      console.log('  quote_token_id:', attrs.quote_token_id);
      console.log('  reserve_in_usd:', attrs.reserve_in_usd);
      console.log('  fdv_usd:', attrs.fdv_usd);
      console.log('  volume_usd_24h:', attrs.volume_usd_24h);
      console.log('  txns_5m:', attrs.transactions_5m || attrs.txns_5m);
    });
  } catch (e) {
    console.error('Gecko error:', e.message);
  }
}

testGecko();

const { PublicKey } = require('@solana/web3.js');

async function getOnChainTokenBalance(connection, ownerPubkey, mint) {
  try {
    const mintPk = new PublicKey(mint);
    const resp = await connection.getParsedTokenAccountsByOwner(ownerPubkey, { mint: mintPk });
    if (!resp || !resp.value || resp.value.length === 0) return 0;
    // Берём первый найденный счёт (обычно один ATA)
    const info = resp.value[0].account.data.parsed.info;
    const amtStr = info.tokenAmount.amount; // строка в минимальных единицах
    const amt = Number(amtStr);
    return Number.isFinite(amt) ? amt : 0;
  } catch (e) {
    return 0;
  }
}

module.exports = { getOnChainTokenBalance };

const { PublicKey } = require('@solana/web3.js');

async function getOnChainTokenBalance(connection, ownerPubkey, mint) {
  try {
    const mintPk = new PublicKey(mint);
    const resp = await connection.getParsedTokenAccountsByOwner(ownerPubkey, { mint: mintPk });
    if (!resp || !resp.value || resp.value.length === 0) return 0;
    // Суммируем все счета по этому mint (вдруг несколько ATA или разные программы)
    let total = 0n;
    for (const acc of resp.value) {
      try {
        const info = acc.account.data.parsed.info;
        const amtStr = info.tokenAmount.amount; // строка в минимальных единицах
        total += BigInt(amtStr);
      } catch (_) {
        // пропускаем некорректные записи
      }
    }
    // Безопасно приводим к Number, если в пределах safe integer
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (total > max) {
      // при экстремально больших значениях — обрежем до MAX_SAFE_INTEGER
      return Number.MAX_SAFE_INTEGER;
    }
    return Number(total);
  } catch (e) {
    return 0;
  }
}

module.exports = { getOnChainTokenBalance };

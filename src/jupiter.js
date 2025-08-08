const fetch = require('node-fetch');
const { VersionedTransaction, PublicKey, TransactionInstruction, TransactionMessage, AddressLookupTableAccount } = require('@solana/web3.js');

const JUP_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUP_SWAP = 'https://quote-api.jup.ag/v6/swap';
const JUP_SWAP_INSTRUCTIONS = 'https://quote-api.jup.ag/v6/swap-instructions';

// Простая лимитация запросов к Jupiter, чтобы не ловить 429 на большом числе позиций
const requestTimestampsMs = [];
async function throttleRequests(maxPerMinute = 50) {
  const now = Date.now();
  // очистка хвоста старше 60с
  while (requestTimestampsMs.length && now - requestTimestampsMs[0] > 60000) {
    requestTimestampsMs.shift();
  }
  if (requestTimestampsMs.length >= maxPerMinute) {
    const waitMs = 60000 - (now - requestTimestampsMs[0]);
    const jitter = 50 + Math.floor(Math.random() * 150);
    await new Promise(r => setTimeout(r, Math.max(0, waitMs) + jitter));
  }
}

async function getQuote({ inputMint, outputMint, amount, slippageBps, onlyDirectRoutes = false, preferDirectRoutes = false }) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps),
    onlyDirectRoutes: String(onlyDirectRoutes),
  });
  if (preferDirectRoutes) params.append('preferDirectRoutes', 'true');
  const url = `${JUP_QUOTE}?${params.toString()}`;

  let attempt = 0;
  let delay = 500;
  // Простая ретрай-логика для 429/временных ошибок
  while (true) {
    await throttleRequests(50);
    const res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'token-helper/1.0' } });
    requestTimestampsMs.push(Date.now());
    if (res.ok) {
      const data = await res.json();
      if (!data || !data.outAmount) throw new Error('Empty quote');
      return data;
    }
    const body = await res.text().catch(() => '');
    if (res.status === 429 && attempt < 4) {
      // экспоненциальный бэкофф
      await new Promise(r => setTimeout(r, delay));
      attempt += 1;
      delay *= 2;
      continue;
    }
    throw new Error(`Quote failed: ${res.status} ${body}`);
  }
}

async function waitForConfirmation(connection, signature, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const st = value && value[0];
    if (st) {
      if (st.err) throw new Error(`Transaction failed: ${signature}`);
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return true;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Timeout waiting confirmation: ${signature}`);
}

async function executeBuiltSwap({ quote, userKeypair, connection, wrapAndUnwrapSol = true, computeUnitPriceMicroLamports = 150000, asLegacy = false }) {
  const swapRes = await fetch(JUP_SWAP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'token-helper/1.0' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: userKeypair.publicKey.toBase58(),
      wrapAndUnwrapSol,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: null,
      asLegacyTransaction: asLegacy,
      computeUnitPriceMicroLamports
    }),
  });
  if (!swapRes.ok) {
    const t = await swapRes.text().catch(() => '');
    throw new Error(`Swap build failed: ${swapRes.status} ${t}`);
  }
  const { swapTransaction } = await swapRes.json();
  const txBuf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([userKeypair]);

  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
  await waitForConfirmation(connection, sig, 90000);
  return sig;
}

function decodeInstruction(ix) {
  const programId = new PublicKey(ix.programId);
  const keys = ix.accounts.map(k => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable }));
  const data = Buffer.from(ix.data, 'base64');
  return new TransactionInstruction({ programId, keys, data });
}

async function executeInstructionMode({ quote, userKeypair, connection, computeUnitPriceMicroLamports = 300000 }) {
  const body = {
    quoteResponse: quote,
    userPublicKey: userKeypair.publicKey.toBase58(),
    computeUnitPriceMicroLamports,
    wrapAndUnwrapSol: true,
    asLegacyTransaction: false,
    // В instruction mode token ledger активен внутри инструкций
  };
  const res = await fetch(JUP_SWAP_INSTRUCTIONS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'token-helper/1.0' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Swap instructions failed: ${res.status} ${t}`);
  }
  const instructionsRes = await res.json();
  const { computeBudgetInstructions = [], setupInstructions = [], swapInstruction, cleanupInstruction, addressLookupTableAddresses = [] } = instructionsRes;

  const ixs = [
    ...computeBudgetInstructions.map(decodeInstruction),
    ...setupInstructions.map(decodeInstruction),
    decodeInstruction(swapInstruction),
  ];
  if (cleanupInstruction) ixs.push(decodeInstruction(cleanupInstruction));

  const recentBlockhash = (await connection.getLatestBlockhash('finalized')).blockhash;

  const lookups = [];
  for (const addr of addressLookupTableAddresses || []) {
    const { value } = await connection.getAddressLookupTable(new PublicKey(addr));
    if (value) lookups.push(value);
  }

  const msg = new TransactionMessage({ payerKey: userKeypair.publicKey, recentBlockhash, instructions: ixs }).compileToV0Message(lookups);
  const tx = new VersionedTransaction(msg);
  tx.sign([userKeypair]);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  await waitForConfirmation(connection, sig, 90000);
  return sig;
}

async function executeSwap(params) {
  try {
    return await executeBuiltSwap(params);
  } catch (e) {
    const msg = String(e.message || e);
    // Авто‑фолбэк на instruction mode при характерных ошибках
    if (msg.includes('use token ledger') || msg.includes('0x1788') || msg.includes('Swap build failed: 500')) {
      return await executeInstructionMode({ quote: params.quote, userKeypair: params.userKeypair, connection: params.connection, computeUnitPriceMicroLamports: 300000 });
    }
    throw e;
  }
}

module.exports = { getQuote, executeSwap }; 

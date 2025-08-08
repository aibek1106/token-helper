const fs = require('fs');
const path = require('path');
const { SEEN_TTL_MIN } = require('./config');

const DB_PATH = path.resolve(process.cwd(), 'db.json');

function ensureShape(data) {
  if (!data.positions) data.positions = [];
  if (!data.trades) data.trades = [];
  if (!data.seen) data.seen = [];
  return data;
}

function readDb() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return ensureShape(data);
  } catch (e) {
    return ensureShape({ positions: [], trades: [], seen: [] });
  }
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(ensureShape(data), null, 2));
}

function nextId(items) {
  let max = 0;
  for (const it of items) max = Math.max(max, it.id || 0);
  return max + 1;
}

function createPosition(p) {
  const db = readDb();
  const id = nextId(db.positions);
  db.positions.push({ id, ...p, withdrawnInitial: 0, tookTp2: 0, closed: 0 });
  writeDb(db);
  return id;
}

function updatePosition(p) {
  const db = readDb();
  const idx = db.positions.findIndex(x => x.id === p.id);
  if (idx === -1) throw new Error('Position not found');
  db.positions[idx] = { ...db.positions[idx], ...p };
  writeDb(db);
}

function getOpenPositions() {
  const db = readDb();
  return db.positions.filter(p => !p.closed);
}

function getPosition(id) {
  const db = readDb();
  return db.positions.find(p => p.id === id);
}

function addTrade(positionId, side, tokens, lamports, sig) {
  const db = readDb();
  const id = nextId(db.trades);
  db.trades.push({ id, positionId, side, tokens, lamports, sig: sig || null, ts: Date.now() });
  writeDb(db);
}

function cleanupSeen(seen) {
  const ttlMs = SEEN_TTL_MIN * 60000;
  const now = Date.now();
  return seen.filter(entry => {
    if (typeof entry === 'string') return true; // совместимость со старым форматом
    return now - (entry.ts || 0) <= ttlMs;
  });
}

function wasSeenMint(mint) {
  const db = readDb();
  db.seen = cleanupSeen(db.seen);
  writeDb(db);
  return db.seen.some(entry => (typeof entry === 'string' ? entry === mint : entry.mint === mint));
}

function markSeenMint(mint) {
  const db = readDb();
  db.seen = cleanupSeen(db.seen);
  if (!db.seen.some(entry => (typeof entry === 'string' ? entry === mint : entry.mint === mint))) {
    db.seen.push({ mint, ts: Date.now() });
  }
  writeDb(db);
}

module.exports = { createPosition, updatePosition, getOpenPositions, getPosition, addTrade, wasSeenMint, markSeenMint }; 
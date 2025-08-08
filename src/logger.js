const fs = require('fs');
const path = require('path');

const LOG_PATH = path.resolve(process.cwd(), 'app.log');

function line(level, msg, meta) {
  const ts = new Date().toISOString();
  const payload = { ts, level, msg, ...(meta ? { meta } : {}) };
  const text = JSON.stringify(payload);
  try { fs.appendFileSync(LOG_PATH, text + '\n'); } catch {}
  if (level === 'error') console.error(`[${ts}] [${level}] ${msg}`, meta || '');
  else if (level === 'warn') console.warn(`[${ts}] [${level}] ${msg}`, meta || '');
  else console.log(`[${ts}] [${level}] ${msg}`, meta || '');
}

module.exports = {
  info: (msg, meta) => line('info', msg, meta),
  warn: (msg, meta) => line('warn', msg, meta),
  error: (msg, meta) => line('error', msg, meta),
}; 
// state.js — lightweight in-memory session store for multi-step flows
// (set username, upload avatar, send DM, admin search/broadcast/ban).
// Keyed by telegram_id. Fine for a single Render instance; for multi-instance
// scaling you'd move this into a `sessions` table, but that's overkill here.

const sessions = new Map();

function get(telegramId) {
  return sessions.get(telegramId) || null;
}

function set(telegramId, data) {
  sessions.set(telegramId, { ...(sessions.get(telegramId) || {}), ...data });
}

function clear(telegramId) {
  sessions.delete(telegramId);
}

module.exports = { get, set, clear };

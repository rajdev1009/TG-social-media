/**
 * ============================================================================
 *  TELEGRAM SOCIAL MEDIA BOT — SINGLE FILE, PRODUCTION READY
 *  Stack: Node.js + Telegraf + Neon (PostgreSQL) + MongoDB + Express
 *  Deploy target: Render (Web Service, webhook mode)
 *
 *  DUAL DATABASE DESIGN
 *  ---------------------------------------------------------------------
 *  Neon (PostgreSQL)  -> structured, relational, counter-heavy data:
 *                         users, likes/dislikes, follows (transactional).
 *  MongoDB            -> flexible, high-volume, append-only data:
 *                         messages (text/voice/audio), reports, admin logs.
 *
 *  PRIVATE CHANNEL MEDIA STORAGE
 *  ---------------------------------------------------------------------
 *  Any photo/voice/audio a user sends (avatar OR inside a DM) is archived
 *  into a private Telegram channel (PRIVATE_CHANNEL_ID). Only the resulting
 *  `file_id` (+ the channel message id, as a backup pointer) is stored in
 *  the database. No binary/base64 data ever touches Postgres or MongoDB,
 *  keeping both databases small and profile/media loads instant.
 *
 *  Run with: node index.js
 * ============================================================================
 */

'use strict';

require('dotenv').config();

const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const { MongoClient } = require('mongodb');

// ============================================================================
// 1. ENVIRONMENT
// ============================================================================

const {
  BOT_TOKEN,
  DATABASE_URL,        // Neon Postgres connection string
  MONGODB_URI,          // MongoDB connection string
  ADMIN_ID,             // your numeric Telegram id
  PRIVATE_CHANNEL_ID,   // e.g. -1001234567890
  WEBHOOK_URL,          // e.g. https://your-app.onrender.com
  PORT = 3000,
  RUN_MODE = 'webhook', // 'webhook' (Render) or 'polling' (local dev)
} = process.env;

const REQUIRED = { BOT_TOKEN, DATABASE_URL, MONGODB_URI, ADMIN_ID, PRIVATE_CHANNEL_ID };
for (const [key, val] of Object.entries(REQUIRED)) {
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
}

const ADMIN_ID_NUM = Number(ADMIN_ID);
const PRIVATE_CHANNEL_ID_VAL = PRIVATE_CHANNEL_ID;

// ============================================================================
// 2. POSTGRES (Neon) — pool + schema + query helpers
// ============================================================================

const pgPool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});
pgPool.on('error', (err) => console.error('PG pool error:', err));

// ----------------------------------------------------------------------------
// SAFE SCHEMA MIGRATION
// ----------------------------------------------------------------------------
// This does NOT assume a fresh database. It works whether `users` /
// `reactions` / `follows` already exist (possibly with a different or
// incomplete set of columns) or don't exist at all:
//
//   1. Create each table with just an `id` column if it's missing entirely.
//   2. ALTER TABLE ... ADD COLUMN IF NOT EXISTS for every column the app
//      needs — this fixes "column does not exist" errors on old tables.
//   3. Add a REAL UNIQUE CONSTRAINT (not just an index) on users.telegram_id,
//      users.username, reactions(actor_id, target_id) and
//      follows(follower_id, following_id). Postgres's ON CONFLICT clause can
//      only match against an actual unique constraint or unique index — if
//      the table was created earlier without one, every ON CONFLICT query
//      throws error 42P10. This step is what fixes that.
//   4. Add foreign keys on reactions/follows if they aren't already present.
//   5. Create the remaining lookup indexes.
//
// Every step is idempotent (safe to run on every boot), and adding the
// unique constraint never deletes or touches existing rows — it only fails
// loudly (with a clear log message, not a crash) if genuine duplicate
// telegram_ids/usernames already exist in the table, so you can dedupe them
// by hand before it can be applied.
// ----------------------------------------------------------------------------

async function ensureUniqueConstraint(client, table, columns, constraintName) {
  const cols = Array.isArray(columns) ? columns : [columns];
  const { rows } = await client.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [constraintName]);
  if (rows.length > 0) return; // already exists — nothing to do

  try {
    await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} UNIQUE (${cols.join(', ')});`);
    console.log(`✅ Added UNIQUE constraint ${constraintName} on ${table}(${cols.join(', ')})`);
  } catch (e) {
    if (e.code === '23505') {
      // Duplicate values already exist in an old table — constraint can't be added yet.
      console.error(
        `⚠️  Skipped UNIQUE constraint ${constraintName} on ${table}(${cols.join(', ')}) — ` +
        `duplicate values already exist in the table. Remove the duplicate rows manually and ` +
        `restart the bot; until then, ON CONFLICT queries touching this column will fail (42P10).`
      );
    } else {
      throw e;
    }
  }
}

// If a table already existed before this bot's schema (e.g. `id BIGINT PRIMARY
// KEY` created manually, without BIGSERIAL/IDENTITY), inserts that don't pass
// an explicit id fail with: null value in column "id" violates not-null
// constraint. This detects that case and attaches a real sequence + DEFAULT
// to the id column, picking up numbering after the current max id so it
// never collides with existing rows.
async function ensureIdDefault(client, table) {
  const { rows } = await client.query(
    `SELECT column_default FROM information_schema.columns WHERE table_name = $1 AND column_name = 'id'`,
    [table]
  );
  if (rows[0]?.column_default) return; // already has a working default (bigserial/identity)

  const seqName = `${table}_id_seq`;
  await client.query(`CREATE SEQUENCE IF NOT EXISTS ${seqName};`);
  await client.query(`ALTER SEQUENCE ${seqName} OWNED BY ${table}.id;`);
  await client.query(`ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${seqName}');`);
  await client.query(`SELECT setval('${seqName}', COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false);`);
  console.log(`✅ Fixed missing id default/sequence on ${table}`);
}

async function ensureForeignKey(client, table, column, constraintName, refTable, refColumn) {
  const { rows } = await client.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [constraintName]);
  if (rows.length > 0) return;
  try {
    await client.query(
      `ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${column}) REFERENCES ${refTable}(${refColumn}) ON DELETE CASCADE;`
    );
    console.log(`✅ Added FK ${constraintName} on ${table}(${column})`);
  } catch (e) {
    console.error(`⚠️  Could not add FK ${constraintName} on ${table}(${column}): ${e.message}`);
  }
}

async function initPostgres() {
  const client = await pgPool.connect();
  try {
    // ---- 1. Base tables (minimal — safe no-op if they already exist) ----
    await client.query('CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY);');
    await client.query('CREATE TABLE IF NOT EXISTS reactions (id BIGSERIAL PRIMARY KEY);');
    await client.query('CREATE TABLE IF NOT EXISTS follows (id BIGSERIAL PRIMARY KEY);');

    // ---- 1b. Fix id auto-increment if the table pre-existed without one ----
    await ensureIdDefault(client, 'users');
    await ensureIdDefault(client, 'reactions');
    await ensureIdDefault(client, 'follows');

    // ---- 2. users: add every column the app needs, if missing ----
    const userColumns = [
      ['telegram_id', 'BIGINT'],
      ['telegram_username', 'VARCHAR(64)'],
      ['first_name', 'VARCHAR(128)'],
      ['username', 'VARCHAR(32)'],
      ['bio', "TEXT DEFAULT ''"],
      ['avatar_file_id', 'TEXT'],
      ['avatar_channel_msg_id', 'BIGINT'],
      ['like_count', 'INT DEFAULT 0'],
      ['dislike_count', 'INT DEFAULT 0'],
      ['follower_count', 'INT DEFAULT 0'],
      ['following_count', 'INT DEFAULT 0'],
      ['is_banned', 'BOOLEAN DEFAULT FALSE'],
      ['ban_reason', 'TEXT'],
      ['is_admin', 'BOOLEAN DEFAULT FALSE'],
      ['reg_step', "VARCHAR(32) DEFAULT 'ask_username'"],
      ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
      ['last_active', 'TIMESTAMPTZ DEFAULT NOW()'],
    ];
    for (const [col, ddl] of userColumns) {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col} ${ddl};`);
    }

    // ---- 3. reactions / follows: add missing columns ----
    const reactionColumns = [
      ['actor_id', 'BIGINT'],
      ['target_id', 'BIGINT'],
      ['reaction_type', 'VARCHAR(8)'],
      ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ];
    for (const [col, ddl] of reactionColumns) {
      await client.query(`ALTER TABLE reactions ADD COLUMN IF NOT EXISTS ${col} ${ddl};`);
    }
    const followColumns = [
      ['follower_id', 'BIGINT'],
      ['following_id', 'BIGINT'],
      ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ];
    for (const [col, ddl] of followColumns) {
      await client.query(`ALTER TABLE follows ADD COLUMN IF NOT EXISTS ${col} ${ddl};`);
    }

    // ---- 4. Foreign keys on reactions/follows (added only if missing) ----
    await ensureForeignKey(client, 'reactions', 'actor_id', 'reactions_actor_id_fkey', 'users', 'id');
    await ensureForeignKey(client, 'reactions', 'target_id', 'reactions_target_id_fkey', 'users', 'id');
    await ensureForeignKey(client, 'follows', 'follower_id', 'follows_follower_id_fkey', 'users', 'id');
    await ensureForeignKey(client, 'follows', 'following_id', 'follows_following_id_fkey', 'users', 'id');

    // ---- 5. THE CRITICAL FIX: real UNIQUE constraints so ON CONFLICT works ----
    // This is what error 42P10 was complaining about — ON CONFLICT (telegram_id)
    // needs telegram_id to actually be backed by a unique constraint/index.
    await ensureUniqueConstraint(client, 'users', 'telegram_id', 'users_telegram_id_key');
    await ensureUniqueConstraint(client, 'users', 'username', 'users_username_key');
    await ensureUniqueConstraint(client, 'reactions', ['actor_id', 'target_id'], 'reactions_actor_target_key');
    await ensureUniqueConstraint(client, 'follows', ['follower_id', 'following_id'], 'follows_follower_following_key');

    // ---- 6. Supporting (non-unique) indexes for query speed ----
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_reg_step    ON users(reg_step);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_reactions_target  ON reactions(target_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_reactions_actor   ON reactions(actor_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_follows_follower  ON follows(follower_id);');

    console.log('✅ Postgres (Neon) schema ensured — columns, constraints and indexes verified.');
  } finally {
    client.release();
  }
}

// ---- Postgres query helpers ----

async function getUserByTelegramId(telegramId) {
  const { rows } = await pgPool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return rows[0] || null;
}
async function getUserById(id) {
  const { rows } = await pgPool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}
async function getUserByUsername(username) {
  const { rows } = await pgPool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  return rows[0] || null;
}
async function createUser(telegramId, telegramUsername, firstName) {
  const { rows } = await pgPool.query(
    `INSERT INTO users (telegram_id, telegram_username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE SET telegram_username = EXCLUDED.telegram_username
     RETURNING *`,
    [telegramId, telegramUsername || null, firstName || null]
  );
  return rows[0];
}
async function setUsername(userId, username) {
  const { rows } = await pgPool.query(
    `UPDATE users SET username = $2, reg_step = 'ask_avatar' WHERE id = $1 RETURNING *`,
    [userId, username]
  );
  return rows[0];
}
async function setBio(userId, bio) {
  await pgPool.query('UPDATE users SET bio = $2 WHERE id = $1', [userId, bio]);
}
async function setAvatar(userId, fileId, channelMsgId) {
  const { rows } = await pgPool.query(
    `UPDATE users SET avatar_file_id = $2, avatar_channel_msg_id = $3, reg_step = 'done' WHERE id = $1 RETURNING *`,
    [userId, fileId, channelMsgId]
  );
  return rows[0];
}
async function touchLastActive(userId) {
  await pgPool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [userId]);
}
async function banUser(userId, reason) {
  await pgPool.query('UPDATE users SET is_banned = TRUE, ban_reason = $2 WHERE id = $1', [userId, reason || 'No reason given']);
}
async function unbanUser(userId) {
  await pgPool.query('UPDATE users SET is_banned = FALSE, ban_reason = NULL WHERE id = $1', [userId]);
}
async function getRandomProfile(excludeUserId) {
  const { rows } = await pgPool.query(
    `SELECT * FROM users WHERE id != $1 AND is_banned = FALSE AND reg_step = 'done' ORDER BY RANDOM() LIMIT 1`,
    [excludeUserId]
  );
  return rows[0] || null;
}
async function getAllTelegramIds() {
  const { rows } = await pgPool.query('SELECT telegram_id FROM users WHERE is_banned = FALSE');
  return rows.map((r) => r.telegram_id);
}
async function searchUsers(query) {
  const { rows } = await pgPool.query(
    `SELECT * FROM users WHERE LOWER(username) LIKE LOWER($1) OR LOWER(telegram_username) LIKE LOWER($1) OR telegram_id::TEXT = $2 LIMIT 10`,
    [`%${query}%`, query]
  );
  return rows;
}
async function getUserReaction(actorId, targetId) {
  const { rows } = await pgPool.query('SELECT reaction_type FROM reactions WHERE actor_id = $1 AND target_id = $2', [actorId, targetId]);
  return rows[0]?.reaction_type || null;
}
async function isFollowing(followerId, followingId) {
  const { rows } = await pgPool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [followerId, followingId]);
  return rows.length > 0;
}
async function getPgStats() {
  const { rows } = await pgPool.query(`
    SELECT
      (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COUNT(*) FROM users WHERE is_banned = TRUE) AS banned_users,
      (SELECT COUNT(*) FROM users WHERE last_active > NOW() - INTERVAL '24 hours') AS active_24h,
      (SELECT COUNT(*) FROM users WHERE reg_step != 'done') AS incomplete_registrations,
      (SELECT COUNT(*) FROM reactions WHERE reaction_type = 'like') AS total_likes,
      (SELECT COUNT(*) FROM follows) AS total_follows
  `);
  return rows[0];
}

// Transactional toggle: like/dislike (with switch support)
async function toggleReaction(actorId, targetId, type) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM reactions WHERE actor_id = $1 AND target_id = $2', [actorId, targetId]);
    let result = 'added';
    const col = (t) => (t === 'like' ? 'like_count' : 'dislike_count');

    if (existing.rows.length === 0) {
      await client.query('INSERT INTO reactions (actor_id, target_id, reaction_type) VALUES ($1, $2, $3)', [actorId, targetId, type]);
      await client.query(`UPDATE users SET ${col(type)} = ${col(type)} + 1 WHERE id = $1`, [targetId]);
    } else if (existing.rows[0].reaction_type === type) {
      await client.query('DELETE FROM reactions WHERE actor_id = $1 AND target_id = $2', [actorId, targetId]);
      await client.query(`UPDATE users SET ${col(type)} = GREATEST(${col(type)} - 1, 0) WHERE id = $1`, [targetId]);
      result = 'removed';
    } else {
      const oldType = existing.rows[0].reaction_type;
      await client.query('UPDATE reactions SET reaction_type = $3 WHERE actor_id = $1 AND target_id = $2', [actorId, targetId, type]);
      await client.query(
        `UPDATE users SET ${col(oldType)} = GREATEST(${col(oldType)} - 1, 0), ${col(type)} = ${col(type)} + 1 WHERE id = $1`,
        [targetId]
      );
      result = 'switched';
    }
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Transactional toggle: follow/unfollow
async function toggleFollow(followerId, followingId) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM follows WHERE follower_id = $1 AND following_id = $2', [followerId, followingId]);
    let result;
    if (existing.rows.length > 0) {
      await client.query('DELETE FROM follows WHERE follower_id = $1 AND following_id = $2', [followerId, followingId]);
      await client.query('UPDATE users SET following_count = GREATEST(following_count - 1, 0) WHERE id = $1', [followerId]);
      await client.query('UPDATE users SET follower_count = GREATEST(follower_count - 1, 0) WHERE id = $1', [followingId]);
      result = 'unfollowed';
    } else {
      await client.query('INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)', [followerId, followingId]);
      await client.query('UPDATE users SET following_count = following_count + 1 WHERE id = $1', [followerId]);
      await client.query('UPDATE users SET follower_count = follower_count + 1 WHERE id = $1', [followingId]);
      result = 'followed';
    }
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ============================================================================
// 3. MONGODB — client + collections (messages, reports, admin logs)
// ============================================================================

let mongoClient;
let mongoDb;
let Messages;
let Reports;
let AdminLogs;

async function initMongo() {
  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  mongoDb = mongoClient.db(); // uses the db name embedded in MONGODB_URI
  Messages = mongoDb.collection('messages');
  Reports = mongoDb.collection('reports');
  AdminLogs = mongoDb.collection('admin_logs');

  await Promise.all([
    Messages.createIndex({ receiver_id: 1 }),
    Messages.createIndex({ sender_id: 1 }),
    Messages.createIndex({ created_at: -1 }),
    Reports.createIndex({ status: 1 }),
    AdminLogs.createIndex({ created_at: -1 }),
  ]);
  console.log('✅ MongoDB connected & indexes ensured');
}

// message: { sender_id, receiver_id, sender_tg_id, receiver_tg_id, content, media_type, file_id, channel_msg_id, created_at }
async function saveMessage(doc) {
  await Messages.insertOne({ ...doc, created_at: new Date() });
}
async function createReport(reporterId, reportedId, reason) {
  await Reports.insertOne({ reporter_id: reporterId, reported_id: reportedId, reason, status: 'open', created_at: new Date() });
}
async function getMongoStats() {
  const [totalMessages, openReports, voiceAudioCount] = await Promise.all([
    Messages.countDocuments(),
    Reports.countDocuments({ status: 'open' }),
    Messages.countDocuments({ media_type: { $in: ['voice', 'audio'] } }),
  ]);
  return { totalMessages, openReports, voiceAudioCount };
}
async function logAdminAction(action, details) {
  await AdminLogs.insertOne({ action, details, created_at: new Date() });
}

// ============================================================================
// 4. HELPERS
// ============================================================================

function escapeMd(text = '') {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}
function isValidUsername(username) {
  return /^[a-zA-Z][a-zA-Z0-9_]{2,19}$/.test(username);
}
function profileCaption(user, { isSelf = false } = {}) {
  const lines = [`*${escapeMd(user.username || 'unnamed')}*`];
  if (user.bio) lines.push(escapeMd(user.bio));
  lines.push('');
  lines.push(`❤️ ${user.like_count}   👎 ${user.dislike_count}   👥 ${user.follower_count} followers`);
  if (isSelf) lines.push('\n_This is how others see your profile\\._');
  return lines.join('\n');
}
function realIdTag(user) {
  const handle = user.telegram_username ? `@${user.telegram_username}` : '(no public @handle)';
  return `ID: \`${user.telegram_id}\` ${escapeMd(handle)}`;
}
async function notifyAdmin(bot, text) {
  try {
    await bot.telegram.sendMessage(ADMIN_ID_NUM, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('notifyAdmin failed:', e.message);
  }
}
function isAdminId(tgId) {
  return Number(tgId) === ADMIN_ID_NUM;
}

const BLOCKED_PATTERNS = [/\bt\.me\/\S+/i, /\bhttps?:\/\/\S+/i, /\b(viagra|crypto\s*airdrop|free\s*followers)\b/i];
function isSuspicious(text = '') {
  return BLOCKED_PATTERNS.some((re) => re.test(text));
}

// Forwards any avatar/voice/audio into the private channel and returns the
// channel message id. This is the "private channel storage" optimization —
// the DB only ever stores the returned file_id, never binary data.
async function archiveToChannel(bot, type, fileId, caption) {
  try {
    let sent;
    if (type === 'photo') sent = await bot.telegram.sendPhoto(PRIVATE_CHANNEL_ID_VAL, fileId, { caption });
    else if (type === 'voice') sent = await bot.telegram.sendVoice(PRIVATE_CHANNEL_ID_VAL, fileId, { caption });
    else if (type === 'audio') sent = await bot.telegram.sendAudio(PRIVATE_CHANNEL_ID_VAL, fileId, { caption });
    else return null;
    return sent.message_id;
  } catch (e) {
    console.error('archiveToChannel failed:', e.message);
    return null;
  }
}

// ---- in-memory session store for multi-step flows (single Render instance) ----
const sessions = new Map();
const setSession = (tgId, data) => sessions.set(tgId, { ...(sessions.get(tgId) || {}), ...data });
const getSession = (tgId) => sessions.get(tgId) || null;
const clearSession = (tgId) => sessions.delete(tgId);

// ============================================================================
// 5. KEYBOARDS
// ============================================================================

function mainMenu(admin) {
  const rows = [['🔀 Explore', '👤 My Profile'], ['✉️ Messages', '⚙️ Settings']];
  if (admin) rows.push(['🛠 Admin Panel']);
  return Markup.keyboard(rows).resize();
}
function profileInlineKeyboard(targetId, { liked, disliked, following, likeCount, dislikeCount, isSelf }) {
  if (isSelf) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Edit Bio', 'edit_bio'), Markup.button.callback('🖼 Change Avatar', 'edit_avatar')],
      [Markup.button.callback('🔀 Explore Others', 'explore_next:0')],
    ]);
  }
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`${liked ? '❤️' : '🤍'} Like (${likeCount})`, `like:${targetId}`),
      Markup.button.callback(`${disliked ? '💔' : '👎'} Dislike (${dislikeCount})`, `dislike:${targetId}`),
    ],
    [
      Markup.button.callback(following ? '➖ Unfollow' : '➕ Follow', `follow:${targetId}`),
      Markup.button.callback('💬 Message', `msg:${targetId}`),
    ],
    [
      Markup.button.callback('🔀 Next Profile', `explore_next:${targetId}`),
      Markup.button.callback('🚩 Report', `report:${targetId}`),
    ],
  ]);
}
function adminDashboardKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Stats', 'admin_stats')],
    [Markup.button.callback('🔍 Inspect User', 'admin_inspect')],
    [Markup.button.callback('🚫 Ban User', 'admin_ban'), Markup.button.callback('✅ Unban User', 'admin_unban')],
    [Markup.button.callback('📢 Broadcast', 'admin_broadcast')],
  ]);
}
function cancelInline() {
  return Markup.inlineKeyboard([Markup.button.callback('❌ Cancel', 'cancel_flow')]);
}

// ============================================================================
// 6. BOT
// ============================================================================

const bot = new Telegraf(BOT_TOKEN);
bot.catch((err, ctx) => console.error(`Bot error [${ctx.updateType}]:`, err));

// ---------------- /start & registration wizard ----------------

bot.start(async (ctx) => {
  const tg = ctx.from;
  let user = await getUserByTelegramId(tg.id);

  if (!user) {
    user = await createUser(tg.id, tg.username, tg.first_name);
    await notifyAdmin(bot, `🆕 *New user joined*\n${realIdTag(user)}`);
  }
  if (user.is_banned) return ctx.reply('🚫 You are banned from using this bot.');

  if (user.reg_step === 'ask_username') {
    setSession(tg.id, { flow: 'set_username' });
    return ctx.reply(
      "👋 Welcome! Let's set up your profile.\n\nPick a *public username* (3-20 chars, letters/numbers/underscore, must start with a letter). Other users only ever see this — your real Telegram identity always stays private.",
      { parse_mode: 'Markdown' }
    );
  }
  if (user.reg_step === 'ask_avatar') {
    setSession(tg.id, { flow: 'set_avatar' });
    return ctx.reply('📸 Now send a profile photo (1-5MB). Send /skip to use a default avatar.');
  }

  return ctx.reply(`Welcome back, *${user.username}*! 👋`, { parse_mode: 'Markdown', ...mainMenu(isAdminId(tg.id)) });
});

bot.command('setbio', (ctx) => {
  setSession(ctx.from.id, { flow: 'edit_bio' });
  return ctx.reply('✍️ Send your new bio (max 200 chars):');
});
bot.command('setusername', (ctx) => {
  setSession(ctx.from.id, { flow: 'set_username' });
  return ctx.reply('✍️ Send a new username:');
});
bot.command('setavatar', (ctx) => {
  setSession(ctx.from.id, { flow: 'set_avatar' });
  return ctx.reply('📸 Send a new profile photo:');
});

// ---------------- /admin ----------------

bot.command('admin', async (ctx) => {
  if (!isAdminId(ctx.from.id)) return; // silently ignore — don't reveal the panel
  return ctx.reply('🛠 *Admin Panel*', { parse_mode: 'Markdown', ...adminDashboardKeyboard() });
});
bot.hears('🛠 Admin Panel', async (ctx) => {
  if (!isAdminId(ctx.from.id)) return;
  return ctx.reply('🛠 *Admin Panel*', { parse_mode: 'Markdown', ...adminDashboardKeyboard() });
});

// ---------------- SINGLE unified text router (admin flows + user flows + menu) ----------------
// Everything lives in one handler (instead of chained middlewares) so there is
// no ordering ambiguity between admin-only flows and normal-user flows.

bot.on('text', async (ctx) => {
  const tgId = ctx.from.id;
  const text = ctx.message.text.trim();
  const session = getSession(tgId);
  const user = await getUserByTelegramId(tgId);

  if (user?.is_banned) return ctx.reply('🚫 You are banned from using this bot.');
  if (user) await touchLastActive(user.id);

  // ===== ADMIN-ONLY multi-step flows =====
  if (isAdminId(tgId) && session?.flow?.startsWith('admin_')) {
    if (session.flow === 'admin_inspect') {
      clearSession(tgId);
      const query = text.replace('@', '');
      const results = await searchUsers(query);
      if (results.length === 0) return ctx.reply('No matching users found.');
      for (const u of results) {
        const info = [
          `*${escapeMd(u.username || 'unnamed')}* (db id ${u.id})`,
          realIdTag(u),
          `❤️ ${u.like_count} 👎 ${u.dislike_count} 👥 ${u.follower_count} followers`,
          `Banned: ${u.is_banned ? `Yes (${escapeMd(u.ban_reason || 'n/a')})` : 'No'}`,
          `Joined: ${new Date(u.created_at).toDateString()}`,
        ].join('\n');
        if (u.avatar_file_id) await ctx.replyWithPhoto(u.avatar_file_id, { caption: info, parse_mode: 'Markdown' });
        else await ctx.reply(info, { parse_mode: 'Markdown' });
      }
      return;
    }

    if (session.flow === 'admin_ban') {
      clearSession(tgId);
      const [username, ...reasonParts] = text.split(' ');
      const target = await getUserByUsername(username);
      if (!target) return ctx.reply('User not found.');
      await banUser(target.id, reasonParts.join(' '));
      await logAdminAction('ban', { username, reason: reasonParts.join(' '), telegram_id: target.telegram_id });
      try { await bot.telegram.sendMessage(target.telegram_id, '🚫 You have been banned from this bot.'); } catch (e) {}
      return ctx.reply(`✅ Banned *${escapeMd(username)}*.`, { parse_mode: 'Markdown' });
    }

    if (session.flow === 'admin_unban') {
      clearSession(tgId);
      const target = await getUserByUsername(text);
      if (!target) return ctx.reply('User not found.');
      await unbanUser(target.id);
      await logAdminAction('unban', { username: text, telegram_id: target.telegram_id });
      return ctx.reply(`✅ Unbanned *${escapeMd(text)}*.`, { parse_mode: 'Markdown' });
    }

    if (session.flow === 'admin_broadcast') {
      clearSession(tgId);
      const ids = await getAllTelegramIds();
      let sent = 0, failed = 0;
      await ctx.reply(`📢 Broadcasting to ${ids.length} users...`);
      for (const id of ids) {
        try {
          await bot.telegram.sendMessage(id, `📢 *Announcement*\n\n${text}`, { parse_mode: 'Markdown' });
          sent++;
        } catch (e) { failed++; }
        await new Promise((r) => setTimeout(r, 40)); // gentle rate-limit
      }
      await logAdminAction('broadcast', { sent, failed, message: text });
      return ctx.reply(`✅ Broadcast complete. Sent: ${sent}, Failed: ${failed}`);
    }
  }

  // ===== registration: username step =====
  if (session?.flow === 'set_username') {
    if (!isValidUsername(text)) return ctx.reply('❌ Invalid format. Use 3-20 letters/numbers/underscore, starting with a letter. Try again:');
    const taken = await getUserByUsername(text);
    if (taken) return ctx.reply('❌ That username is already taken. Try another:');
    await setUsername(user.id, text);
    setSession(tgId, { flow: 'set_avatar' });
    return ctx.reply(`✅ Username set to *${escapeMd(text)}*!\n\n📸 Now send a profile photo (1-5MB), or /skip for a default avatar.`, { parse_mode: 'Markdown' });
  }

  // ===== registration: avatar step (/skip branch) =====
  if (session?.flow === 'set_avatar' && text === '/skip') {
    await setAvatar(user.id, null, null);
    clearSession(tgId);
    return ctx.reply('✅ Profile complete! Welcome aboard 🎉', mainMenu(isAdminId(tgId)));
  }

  // ===== DM composer: text message =====
  if (session?.flow === 'sending_dm' && session.targetId) {
    const target = await getUserById(session.targetId);
    clearSession(tgId);
    if (!target) return ctx.reply('That user no longer exists.', mainMenu(isAdminId(tgId)));

    if (isSuspicious(text)) {
      await notifyAdmin(bot, `⚠️ *Suspicious DM blocked*\nFrom: ${realIdTag(user)}\nTo: ${realIdTag(target)}\nContent: ${escapeMd(text.slice(0, 200))}`);
      return ctx.reply('⚠️ Your message looks like spam and was not delivered.', mainMenu(isAdminId(tgId)));
    }

    await saveMessage({
      sender_id: user.id, receiver_id: target.id,
      sender_tg_id: user.telegram_id, receiver_tg_id: target.telegram_id,
      content: text, media_type: 'text', file_id: null, channel_msg_id: null,
    });

    try {
      await bot.telegram.sendMessage(
        target.telegram_id,
        `💬 New message from *${escapeMd(user.username)}*:\n\n${text}\n\n_Reply: search this user via Explore and tap Message._`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) { /* user may have blocked the bot */ }

    // Real-ID mapping only ever goes to the admin, never to the recipient.
    await notifyAdmin(bot, `✉️ *DM sent (text)*\nFrom: ${realIdTag(user)} (@${user.username})\nTo: ${realIdTag(target)} (@${target.username})\nContent: ${escapeMd(text.slice(0, 300))}`);

    return ctx.reply('✅ Message sent!', mainMenu(isAdminId(tgId)));
  }

  // ===== bio editor =====
  if (session?.flow === 'edit_bio') {
    clearSession(tgId);
    await setBio(user.id, text.slice(0, 200));
    return ctx.reply('✅ Bio updated!', mainMenu(isAdminId(tgId)));
  }

  // ===== main menu (only once registration is complete) =====
  if (!user || user.reg_step !== 'done') {
    return ctx.reply('Send /start to begin registration.');
  }

  switch (text) {
    case '🔀 Explore': return sendExploreProfile(ctx, user.id);
    case '👤 My Profile': return sendOwnProfile(ctx, user);
    case '✉️ Messages': return ctx.reply('📥 To message someone, open their profile via 🔀 Explore and tap 💬 Message.');
    case '⚙️ Settings': return ctx.reply('⚙️ Settings:\n/setusername — change username\n/setbio — change bio\n/setavatar — change avatar');
    default: return; // unrecognized text, ignore quietly
  }
});

// ---------------- ALL MEDIA (photo / voice / audio) -> archive to private channel ----------------
// Single rule, everywhere: whatever media a user sends (avatar OR inside a DM),
// it is forwarded into PRIVATE_CHANNEL_ID and ONLY the resulting file_id
// (+ channel message id as backup) is written to the database. Actual media
// bytes NEVER touch Postgres or MongoDB, no matter how many messages pile up —
// so a 500MB free-tier database limit is never at risk from media volume.

async function handleDmMedia(ctx, mediaType, fileObj) {
  const tgId = ctx.from.id;
  const session = getSession(tgId);
  if (session?.flow !== 'sending_dm' || !session.targetId) {
    return ctx.reply('📎 To send a photo/voice/audio message, open a profile via 🔀 Explore and tap 💬 Message first.');
  }

  const user = await getUserByTelegramId(tgId);
  const target = await getUserById(session.targetId);
  clearSession(tgId);
  if (!user || !target) return ctx.reply('That user no longer exists.', mainMenu(isAdminId(tgId)));

  const fileId = fileObj.file_id;

  // Archive into the private channel for backup/moderation — DB only stores file_id.
  const channelMsgId = await archiveToChannel(
    bot, mediaType, fileId,
    `DM ${mediaType} — from tg:${user.telegram_id} to tg:${target.telegram_id}`
  );

  await saveMessage({
    sender_id: user.id, receiver_id: target.id,
    sender_tg_id: user.telegram_id, receiver_tg_id: target.telegram_id,
    content: null, media_type: mediaType, file_id: fileId, channel_msg_id: channelMsgId,
  });

  try {
    const caption = `📎 New ${mediaType} message from *${escapeMd(user.username)}*`;
    if (mediaType === 'voice') await bot.telegram.sendVoice(target.telegram_id, fileId, { caption, parse_mode: 'Markdown' });
    else if (mediaType === 'audio') await bot.telegram.sendAudio(target.telegram_id, fileId, { caption, parse_mode: 'Markdown' });
    else await bot.telegram.sendPhoto(target.telegram_id, fileId, { caption, parse_mode: 'Markdown' });
  } catch (e) { /* user may have blocked the bot */ }

  await notifyAdmin(
    bot,
    `✉️ *DM sent (${mediaType})*\nFrom: ${realIdTag(user)} (@${user.username})\nTo: ${realIdTag(target)} (@${target.username})\nArchived in private channel: ${channelMsgId ? 'yes' : 'no'}`
  );

  const label = mediaType === 'voice' ? 'Voice note' : mediaType === 'audio' ? 'Audio' : 'Photo';
  return ctx.reply(`✅ ${label} sent!`, mainMenu(isAdminId(tgId)));
}

// Photo needs a router: it can mean "set my avatar" OR "send a photo in a DM",
// depending on which flow the user's session is currently in.
bot.on('photo', async (ctx) => {
  const tgId = ctx.from.id;
  const session = getSession(tgId);
  const photo = ctx.message.photo[ctx.message.photo.length - 1]; // highest resolution

  if (session?.flow === 'set_avatar') {
    const user = await getUserByTelegramId(tgId);
    if (!user) return;
    const fileId = photo.file_id;
    const channelMsgId = await archiveToChannel(
      bot, 'photo', fileId,
      `Avatar — user_id:${user.id} — @${user.telegram_username || 'n/a'} — tg:${user.telegram_id}`
    );
    await setAvatar(user.id, fileId, channelMsgId);
    clearSession(tgId);
    return ctx.reply('✅ Profile complete! Welcome aboard 🎉', mainMenu(isAdminId(tgId)));
  }

  if (session?.flow === 'sending_dm') {
    return handleDmMedia(ctx, 'photo', photo);
  }

  // stray photo with no active flow — ignore quietly
});

bot.on('voice', (ctx) => handleDmMedia(ctx, 'voice', ctx.message.voice));
bot.on('audio', (ctx) => handleDmMedia(ctx, 'audio', ctx.message.audio));

// ---------------- inline callback actions ----------------

async function handleReaction(ctx, type) {
  const targetId = Number(ctx.match[1]);
  const actor = await getUserByTelegramId(ctx.from.id);
  if (!actor) return ctx.answerCbQuery('Please /start first.');
  if (actor.id === targetId) return ctx.answerCbQuery("You can't react to your own profile 🙂");

  const result = await toggleReaction(actor.id, targetId, type);
  const target = await getUserById(targetId);
  await ctx.answerCbQuery(result === 'removed' ? 'Removed' : type === 'like' ? '❤️ Liked!' : '👎 Disliked');
  await refreshProfileMessage(ctx, actor, target);
}
bot.action(/^like:(\d+)$/, (ctx) => handleReaction(ctx, 'like'));
bot.action(/^dislike:(\d+)$/, (ctx) => handleReaction(ctx, 'dislike'));

bot.action(/^follow:(\d+)$/, async (ctx) => {
  const targetId = Number(ctx.match[1]);
  const actor = await getUserByTelegramId(ctx.from.id);
  if (!actor) return ctx.answerCbQuery('Please /start first.');
  if (actor.id === targetId) return ctx.answerCbQuery("You can't follow yourself 🙂");

  const result = await toggleFollow(actor.id, targetId);
  const target = await getUserById(targetId);

  if (result === 'followed') {
    try { await bot.telegram.sendMessage(target.telegram_id, `➕ *${escapeMd(actor.username)}* started following you!`, { parse_mode: 'Markdown' }); } catch (e) {}
  }
  await ctx.answerCbQuery(result === 'followed' ? '✅ Following' : 'Unfollowed');
  await refreshProfileMessage(ctx, actor, target);
});

bot.action(/^msg:(\d+)$/, async (ctx) => {
  const targetId = Number(ctx.match[1]);
  const actor = await getUserByTelegramId(ctx.from.id);
  if (!actor) return ctx.answerCbQuery('Please /start first.');
  if (actor.id === targetId) return ctx.answerCbQuery("You can't message yourself 🙂");

  setSession(ctx.from.id, { flow: 'sending_dm', targetId });
  await ctx.answerCbQuery();
  return ctx.reply('✍️ Send text, a photo, a voice note, or an audio file — it will be delivered anonymously (your public username shown, real identity protected):', cancelInline());
});

bot.action(/^report:(\d+)$/, async (ctx) => {
  const targetId = Number(ctx.match[1]);
  const actor = await getUserByTelegramId(ctx.from.id);
  const target = await getUserById(targetId);
  if (!actor || !target) return ctx.answerCbQuery('Error');

  await createReport(actor.id, targetId, 'Reported via profile button');
  await notifyAdmin(bot, `🚩 *Report filed*\nReporter: ${realIdTag(actor)} (@${actor.username})\nReported: ${realIdTag(target)} (@${target.username})`);
  return ctx.answerCbQuery('🚩 Reported to admin. Thank you.');
});

bot.action(/^explore_next:(\d+)$/, async (ctx) => {
  const actor = await getUserByTelegramId(ctx.from.id);
  if (!actor) return ctx.answerCbQuery('Please /start first.');
  await ctx.answerCbQuery();
  return sendExploreProfile(ctx, actor.id);
});

bot.action('cancel_flow', async (ctx) => {
  clearSession(ctx.from.id);
  await ctx.answerCbQuery('Cancelled');
  return ctx.reply('Cancelled.');
});
bot.action('edit_bio', async (ctx) => {
  setSession(ctx.from.id, { flow: 'edit_bio' });
  await ctx.answerCbQuery();
  return ctx.reply('✍️ Send your new bio (max 200 chars):');
});
bot.action('edit_avatar', async (ctx) => {
  setSession(ctx.from.id, { flow: 'set_avatar' });
  await ctx.answerCbQuery();
  return ctx.reply('📸 Send a new profile photo:');
});

// ---------------- admin inline actions ----------------

bot.action('admin_stats', async (ctx) => {
  if (!isAdminId(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const [pg, mongo] = await Promise.all([getPgStats(), getMongoStats()]);
  const textOut = [
    '📊 *Bot Statistics*', '',
    `👥 Total users: *${pg.total_users}*`,
    `🟢 Active last 24h: *${pg.active_24h}*`,
    `🚫 Banned: *${pg.banned_users}*`,
    `⏳ Incomplete registrations: *${pg.incomplete_registrations}*`,
    `❤️ Total likes: *${pg.total_likes}*`,
    `➕ Total follows: *${pg.total_follows}*`,
    `✉️ Total messages (Mongo): *${mongo.totalMessages}*`,
    `🎙 Voice/Audio messages: *${mongo.voiceAudioCount}*`,
    `🚩 Open reports: *${mongo.openReports}*`,
  ].join('\n');
  return ctx.reply(textOut, { parse_mode: 'Markdown' });
});
bot.action('admin_inspect', async (ctx) => {
  if (!isAdminId(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  setSession(ctx.from.id, { flow: 'admin_inspect' });
  return ctx.reply('🔍 Send a username, @handle, or numeric telegram id to inspect:');
});
bot.action('admin_ban', async (ctx) => {
  if (!isAdminId(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  setSession(ctx.from.id, { flow: 'admin_ban' });
  return ctx.reply('🚫 Send: `username reason here` to ban a user.', { parse_mode: 'Markdown' });
});
bot.action('admin_unban', async (ctx) => {
  if (!isAdminId(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  setSession(ctx.from.id, { flow: 'admin_unban' });
  return ctx.reply('✅ Send the username to unban:');
});
bot.action('admin_broadcast', async (ctx) => {
  if (!isAdminId(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  setSession(ctx.from.id, { flow: 'admin_broadcast' });
  return ctx.reply('📢 Send the message to broadcast to ALL active users:');
});

// ---------------- shared render helpers ----------------

async function sendExploreProfile(ctx, actorId) {
  const target = await getRandomProfile(actorId);
  if (!target) return ctx.reply('No other profiles to explore yet. Check back soon!');

  const [liked, following] = await Promise.all([getUserReaction(actorId, target.id), isFollowing(actorId, target.id)]);
  const opts = { liked: liked === 'like', disliked: liked === 'dislike', following, likeCount: target.like_count, dislikeCount: target.dislike_count, isSelf: false };
  const caption = profileCaption(target);
  const kb = profileInlineKeyboard(target.id, opts);

  if (target.avatar_file_id) return ctx.replyWithPhoto(target.avatar_file_id, { caption, parse_mode: 'Markdown', ...kb });
  return ctx.reply(caption, { parse_mode: 'Markdown', ...kb });
}

async function sendOwnProfile(ctx, user) {
  const caption = profileCaption(user, { isSelf: true });
  const kb = profileInlineKeyboard(user.id, { isSelf: true });
  if (user.avatar_file_id) return ctx.replyWithPhoto(user.avatar_file_id, { caption, parse_mode: 'Markdown', ...kb });
  return ctx.reply(caption, { parse_mode: 'Markdown', ...kb });
}

async function refreshProfileMessage(ctx, actor, target) {
  const [liked, following] = await Promise.all([getUserReaction(actor.id, target.id), isFollowing(actor.id, target.id)]);
  const opts = { liked: liked === 'like', disliked: liked === 'dislike', following, likeCount: target.like_count, dislikeCount: target.dislike_count, isSelf: false };
  try {
    await ctx.editMessageReplyMarkup(profileInlineKeyboard(target.id, opts).reply_markup);
  } catch (e) { /* message may be too old to edit */ }
}

// ============================================================================
// 7. SERVER BOOT — Express (health check + webhook) / polling + graceful shutdown
// ============================================================================

async function main() {
  await initPostgres();
  await initMongo();

  const app = express();
  app.use(express.json());
  app.get('/', (req, res) => res.send('🤖 Telegram Social Bot is running.'));
  app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  if (RUN_MODE === 'webhook') {
    if (!WEBHOOK_URL) throw new Error('WEBHOOK_URL is required when RUN_MODE=webhook');
    const secretPath = `/telegraf/${bot.secretPathComponent()}`;
    app.use(bot.webhookCallback(secretPath));
    await bot.telegram.setWebhook(`${WEBHOOK_URL}${secretPath}`);
    console.log(`✅ Webhook set at ${WEBHOOK_URL}${secretPath}`);
  } else {
    await bot.launch();
    console.log('✅ Bot launched in polling mode');
  }

  app.listen(PORT, () => console.log(`🌐 Server listening on port ${PORT}`));

  const shutdown = async (signal) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    try {
      if (RUN_MODE !== 'webhook') bot.stop(signal);
      await pgPool.end();
      if (mongoClient) await mongoClient.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

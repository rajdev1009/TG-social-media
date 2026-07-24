/* =============================================================================
   ECHO — server.js
   Instagram-style social app using Telegram channels/bots as a free media CDN,
   with a dual-database architecture:
     - Neon (PostgreSQL): users, posts, stories, stickers, direct messages, reports
     - MongoDB:           follows, likes, shares (high-frequency social graph data)
   Flat file structure — everything the backend needs lives in this one file.
============================================================================= */

require('dotenv').config();
const express     = require('express');
const { Pool }    = require('pg');
const mongoose    = require('mongoose');
const { Telegraf } = require('telegraf');
const bcrypt      = require('bcryptjs');
const cookieParser = require('cookie-parser');
const multer      = require('multer');
const crypto      = require('crypto');
const https       = require('https');

/* =============================================================================
   CONFIG
============================================================================= */
const PORT             = process.env.PORT || 3000;
const RUN_MODE          = process.env.RUN_MODE || 'polling';        // 'polling' | 'webhook'
const WEBHOOK_URL       = process.env.WEBHOOK_URL;                  // e.g. https://your-app.onrender.com
const DATABASE_URL      = process.env.DATABASE_URL;
const MONGODB_URI       = process.env.MONGODB_URI;
const ADMIN_TELEGRAM_ID = String(process.env.ADMIN_TELEGRAM_ID || '');
// Whichever web account registers/logs in with this username is automatically
// flagged is_admin = true (self-healing on every login) — this is what unlocks
// the web Admin Dashboard for the owner, controlled purely via .env.
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || '').toLowerCase();
const PRIVATE_CHANNEL_ID = process.env.PRIVATE_CHANNEL_ID;

// Main bot handles: account-linking DMs + is also the restricted Admin Bot.
const MAIN_BOT_TOKEN = process.env.BOT_TOKEN;

// Up to 5 additional bots used purely as an upload/streaming pool, rotated
// round-robin so no single bot token ever hits Telegram's per-bot rate limits.
const POOL_BOT_TOKENS = [
  process.env.BOT_TOKEN_2,
  process.env.BOT_TOKEN_3,
  process.env.BOT_TOKEN_4,
  process.env.BOT_TOKEN_5,
  process.env.BOT_TOKEN_6,
].filter(Boolean);

if (!MAIN_BOT_TOKEN) throw new Error('BOT_TOKEN is required in .env');
if (!DATABASE_URL) throw new Error('DATABASE_URL is required in .env');
if (!MONGODB_URI) throw new Error('MONGODB_URI is required in .env');
if (!PRIVATE_CHANNEL_ID) throw new Error('PRIVATE_CHANNEL_ID is required in .env');

/* =============================================================================
   POSTGRES (Neon) — pool + safe migration
============================================================================= */
const pgPool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Reused pattern: works whether tables already exist (possibly with a
// different/older shape) or don't exist yet. Adds any missing columns,
// backfills a real id sequence if one is missing, and guarantees real
// UNIQUE constraints so ON CONFLICT clauses never throw 42P10.
async function ensureIdDefault(client, table) {
  const { rows } = await client.query(
    `SELECT column_default FROM information_schema.columns WHERE table_name = $1 AND column_name = 'id'`,
    [table]
  );
  if (rows[0]?.column_default) return;
  const seqName = `${table}_id_seq`;
  await client.query(`CREATE SEQUENCE IF NOT EXISTS ${seqName};`);
  await client.query(`ALTER SEQUENCE ${seqName} OWNED BY ${table}.id;`);
  await client.query(`ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${seqName}');`);
  await client.query(`SELECT setval('${seqName}', COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false);`);
  console.log(`✅ Fixed missing id default/sequence on ${table}`);
}

async function ensureUniqueConstraint(client, table, columns, constraintName) {
  const cols = Array.isArray(columns) ? columns : [columns];
  const { rows } = await client.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [constraintName]);
  if (rows.length > 0) return;
  try {
    await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} UNIQUE (${cols.join(', ')});`);
    console.log(`✅ Added UNIQUE constraint ${constraintName} on ${table}(${cols.join(', ')})`);
  } catch (e) {
    if (e.code === '23505') {
      console.error(`⚠️  Skipped UNIQUE constraint ${constraintName} on ${table}(${cols.join(', ')}) — duplicate values already exist. Dedupe manually.`);
    } else { throw e; }
  }
}

async function ensureForeignKey(client, table, column, constraintName, refTable, refColumn) {
  const { rows } = await client.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [constraintName]);
  if (rows.length > 0) return;
  try {
    await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${column}) REFERENCES ${refTable}(${refColumn}) ON DELETE CASCADE;`);
    console.log(`✅ Added FK ${constraintName} on ${table}(${column})`);
  } catch (e) {
    console.error(`⚠️  Could not add FK ${constraintName} on ${table}(${column}): ${e.message}`);
  }
}

async function addColumns(client, table, columns) {
  for (const [col, ddl] of columns) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${ddl};`);
  }
}

async function initPostgres() {
  const client = await pgPool.connect();
  try {
    // ---- Base tables (minimal — safe no-op if they already exist) ----
    await client.query('CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY);');
    await client.query('CREATE TABLE IF NOT EXISTS posts (id BIGSERIAL PRIMARY KEY);');
    await client.query('CREATE TABLE IF NOT EXISTS stories (id BIGSERIAL PRIMARY KEY);');
    await client.query('CREATE TABLE IF NOT EXISTS stickers (id BIGSERIAL PRIMARY KEY);');
    await client.query('CREATE TABLE IF NOT EXISTS messages (id BIGSERIAL PRIMARY KEY);');
    await client.query('CREATE TABLE IF NOT EXISTS blocks (id BIGSERIAL PRIMARY KEY);');
    await client.query('CREATE TABLE IF NOT EXISTS reports (id BIGSERIAL PRIMARY KEY);');
    await client.query('CREATE TABLE IF NOT EXISTS notifications (id BIGSERIAL PRIMARY KEY);');

    for (const t of ['users','posts','stories','stickers','messages','blocks','reports','notifications']) {
      await ensureIdDefault(client, t);
    }

    // ---- users ----
    await addColumns(client, 'users', [
      ['telegram_id', 'BIGINT'],
      ['username', 'VARCHAR(32)'],
      ['password_hash', 'TEXT'],
      ['bio', "TEXT DEFAULT ''"],
      ['avatar_file_id', 'TEXT'],
      ['avatar_bot_index', 'INT DEFAULT 0'],
      ['is_banned', 'BOOLEAN DEFAULT FALSE'],
      ['is_admin', 'BOOLEAN DEFAULT FALSE'],
      ['is_private', 'BOOLEAN DEFAULT FALSE'],
      ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ]);

    // ---- posts ----
    await addColumns(client, 'posts', [
      ['user_id', 'BIGINT'],
      ['file_id', 'TEXT'],
      ['bot_index', 'INT DEFAULT 0'],
      ['message_id', 'BIGINT'],
      ['media_type', "VARCHAR(16) DEFAULT 'photo'"],
      ['caption', "TEXT DEFAULT ''"],
      ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ]);

    // ---- stories (24h expiry) ----
    await addColumns(client, 'stories', [
      ['user_id', 'BIGINT'],
      ['file_id', 'TEXT'],
      ['bot_index', 'INT DEFAULT 0'],
      ['message_id', 'BIGINT'],
      ['bg_theme', "TEXT DEFAULT ''"],
      ['sticker', "TEXT DEFAULT ''"],
      ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
      ['expires_at', "TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')"],
    ]);

    // ---- stickers (synced from admin) ----
    await addColumns(client, 'stickers', [
      ['file_id', 'TEXT'],
      ['emoji_label', "VARCHAR(16) DEFAULT ''"],
      ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ]);

    // ---- direct messages ----
    await addColumns(client, 'messages', [
      ['sender_id', 'BIGINT'],
      ['receiver_id', 'BIGINT'],
      ['body', "TEXT DEFAULT ''"],
      ['media_file_id', 'TEXT'],
      ['bot_index', 'INT DEFAULT 0'],
      ['read', 'BOOLEAN DEFAULT FALSE'],
      ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ]);

    // ---- block list ----
    await addColumns(client, 'blocks', [
      ['blocker_id', 'BIGINT'],
      ['blocked_id', 'BIGINT'],
      ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ]);

    // ---- reports (flagged content/accounts, reviewed via /reports) ----
    await addColumns(client, 'reports', [
      ['reporter_id', 'BIGINT'],
      ['post_id', 'BIGINT'],
      ['reason', "TEXT DEFAULT ''"],
      ['resolved', 'BOOLEAN DEFAULT FALSE'],
      ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ]);

    // ---- notifications (likes, follows — powers the Activity tab) ----
    await addColumns(client, 'notifications', [
      ['recipient_id', 'BIGINT'],
      ['actor_id', 'BIGINT'],
      ['type', "VARCHAR(16) DEFAULT 'like'"], // 'like' | 'follow'
      ['post_id', 'BIGINT'],
      ['read', 'BOOLEAN DEFAULT FALSE'],
      ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ]);

    // ---- Foreign keys ----
    await ensureForeignKey(client, 'posts', 'user_id', 'posts_user_id_fkey', 'users', 'id');
    await ensureForeignKey(client, 'notifications', 'recipient_id', 'notifications_recipient_fkey', 'users', 'id');
    await ensureForeignKey(client, 'notifications', 'actor_id', 'notifications_actor_fkey', 'users', 'id');
    await ensureForeignKey(client, 'notifications', 'post_id', 'notifications_post_fkey', 'posts', 'id');
    await ensureForeignKey(client, 'stories', 'user_id', 'stories_user_id_fkey', 'users', 'id');
    await ensureForeignKey(client, 'messages', 'sender_id', 'messages_sender_id_fkey', 'users', 'id');
    await ensureForeignKey(client, 'messages', 'receiver_id', 'messages_receiver_id_fkey', 'users', 'id');
    await ensureForeignKey(client, 'blocks', 'blocker_id', 'blocks_blocker_id_fkey', 'users', 'id');
    await ensureForeignKey(client, 'blocks', 'blocked_id', 'blocks_blocked_id_fkey', 'users', 'id');
    await ensureForeignKey(client, 'reports', 'reporter_id', 'reports_reporter_id_fkey', 'users', 'id');
    await ensureForeignKey(client, 'reports', 'post_id', 'reports_post_id_fkey', 'posts', 'id');

    // ---- Unique constraints (needed for ON CONFLICT + data integrity) ----
    await ensureUniqueConstraint(client, 'users', 'telegram_id', 'users_telegram_id_key');
    await ensureUniqueConstraint(client, 'users', 'username', 'users_username_key');
    await ensureUniqueConstraint(client, 'blocks', ['blocker_id', 'blocked_id'], 'blocks_pair_key');

    // ---- Supporting indexes ----
    await client.query('CREATE INDEX IF NOT EXISTS idx_posts_user       ON posts(user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_posts_created    ON posts(created_at DESC);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_stories_user     ON stories(user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_stories_expires  ON stories(expires_at);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_messages_pair    ON messages(sender_id, receiver_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_reports_resolved ON reports(resolved);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id, created_at DESC);');

    console.log('✅ Postgres (Neon) schema ensured — columns, constraints and indexes verified.');
  } finally {
    client.release();
  }
}

/* =============================================================================
   MONGODB — high-frequency social graph (follows / likes / shares)
============================================================================= */
const followSchema = new mongoose.Schema({
  followerId:  { type: Number, required: true, index: true },
  followingId: { type: Number, required: true, index: true },
  createdAt:   { type: Date, default: Date.now },
});
followSchema.index({ followerId: 1, followingId: 1 }, { unique: true });

const likeSchema = new mongoose.Schema({
  postId:    { type: Number, required: true, index: true },
  userId:    { type: Number, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
});
likeSchema.index({ postId: 1, userId: 1 }, { unique: true });

const shareSchema = new mongoose.Schema({
  postId:    { type: Number, required: true, index: true },
  userId:    { type: Number, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
});

const Follow = mongoose.model('Follow', followSchema);
const Like   = mongoose.model('Like', likeSchema);
const Share  = mongoose.model('Share', shareSchema);

async function initMongo() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ MongoDB connected & indexes ensured');
}

/* =============================================================================
   TELEGRAM MULTI-BOT POOL (media CDN)
============================================================================= */
const mainBot = new Telegraf(MAIN_BOT_TOKEN);
const poolBots = POOL_BOT_TOKENS.map(token => new Telegraf(token));
const allBots  = [mainBot, ...poolBots]; // index 0 = main bot, 1..5 = pool

let rotationCursor = 0;
function getNextBot() {
  const bot = allBots[rotationCursor % allBots.length];
  const index = rotationCursor % allBots.length;
  rotationCursor++;
  return { bot, index };
}

// Uploads a buffer to the private storage channel using the next bot in the
// rotation. Returns the file_id, the Telegram message_id (needed later to
// delete the message), and which bot index sent it (a file_id is only valid
// when re-fetched through the SAME bot that received it).
async function uploadToChannel(buffer, filename, mimetype, caption = '') {
  const { bot, index } = getNextBot();
  const isVideo = mimetype.startsWith('video/');
  const source = { source: buffer, filename };

  const message = isVideo
    ? await bot.telegram.sendVideo(PRIVATE_CHANNEL_ID, source, { caption })
    : await bot.telegram.sendPhoto(PRIVATE_CHANNEL_ID, source, { caption });

  const fileId = isVideo
    ? message.video.file_id
    : message.photo[message.photo.length - 1].file_id;

  return { fileId, messageId: message.message_id, botIndex: index, mediaType: isVideo ? 'video' : 'photo' };
}

async function deleteFromChannel(messageId) {
  try {
    await mainBot.telegram.deleteMessage(PRIVATE_CHANNEL_ID, messageId);
  } catch (e) {
    console.error(`⚠️  Could not delete channel message ${messageId}: ${e.message}`);
  }
}

// Streams a file straight from Telegram's CDN through our server, using the
// same bot that originally uploaded it (required for the file_id to resolve).
async function streamTelegramFile(fileId, botIndex, res) {
  const bot = allBots[botIndex] || mainBot;
  const link = await bot.telegram.getFileLink(fileId); // returns a full https URL
  https.get(link.href, (tgRes) => {
    res.setHeader('Content-Type', tgRes.headers['content-type'] || 'application/octet-stream');
    if (tgRes.headers['content-length']) res.setHeader('Content-Length', tgRes.headers['content-length']);
    tgRes.pipe(res);
  }).on('error', (e) => {
    console.error('Stream error:', e.message);
    if (!res.headersSent) res.status(502).json({ error: 'Failed to stream file from Telegram' });
  });
}

/* =============================================================================
   EXPRESS APP
============================================================================= */
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('.', { index: 'index.html' })); // serves index.html from the flat root

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } }); // up to 1GB

/* -------------------- Sessions (simple in-memory token store) -------------------- */
// For a single-instance deploy this is fine. For multi-instance/Render scaling,
// swap this Map for a Redis-backed store later — the interface below stays the same.
const sessions = new Map(); // token -> userId

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, userId);
  return token;
}

async function requireAuth(req, res, next) {
  const token = req.cookies.echo_session;
  const userId = token && sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const { rows } = await pgPool.query('SELECT * FROM users WHERE id = $1', [userId]);
  if (!rows[0] || rows[0].is_banned) return res.status(403).json({ error: 'Account unavailable' });
  req.user = rows[0];
  next();
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

async function ensureAdminFlag(user) {
  if (ADMIN_USERNAME && user.username === ADMIN_USERNAME && !user.is_admin) {
    await pgPool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [user.id]);
    user.is_admin = true;
  }
  return user;
}

/* =============================================================================
   AUTH ROUTES
============================================================================= */
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || password.length < 6) {
      return res.status(400).json({ error: 'Username and a password of 6+ characters are required' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pgPool.query(
      `INSERT INTO users (username, password_hash) VALUES ($1, $2)
       ON CONFLICT (username) DO NOTHING RETURNING id, username`,
      [username.toLowerCase(), hash]
    );
    if (!rows[0]) return res.status(409).json({ error: 'Username already taken' });
    await ensureAdminFlag(rows[0]);
    const token = createSession(rows[0].id);
    res.cookie('echo_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ id: rows[0].id, username: rows[0].username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const { rows } = await pgPool.query('SELECT * FROM users WHERE username = $1', [String(username).toLowerCase()]);
    const user = rows[0];
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (user.is_banned) return res.status(403).json({ error: 'This account has been banned' });
    await ensureAdminFlag(user);
    const token = createSession(user.id);
    res.cookie('echo_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ id: user.id, username: user.username, bio: user.bio });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete(req.cookies.echo_session);
  res.clearCookie('echo_session');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  const [followers, following, postCount] = await Promise.all([
    Follow.countDocuments({ followingId: req.user.id }),
    Follow.countDocuments({ followerId: req.user.id }),
    pgPool.query('SELECT COUNT(*) FROM posts WHERE user_id = $1', [req.user.id]),
  ]);
  res.json({
    id: req.user.id, username: req.user.username, bio: req.user.bio,
    avatarFileId: req.user.avatar_file_id, isPrivate: req.user.is_private,
    followers, following, posts: Number(postCount.rows[0].count),
  });
});

/* =============================================================================
   POSTS
============================================================================= */
app.get('/api/feed', requireAuth, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT p.id, p.file_id, p.bot_index, p.media_type, p.caption, p.created_at,
            u.id AS user_id, u.username, u.avatar_file_id, u.avatar_bot_index
     FROM posts p JOIN users u ON u.id = p.user_id
     ORDER BY p.created_at DESC LIMIT 50`
  );
  const postIds = rows.map(r => r.id);
  const likeCounts = await Like.aggregate([
    { $match: { postId: { $in: postIds } } },
    { $group: { _id: '$postId', count: { $sum: 1 } } },
  ]);
  const myLikes = await Like.find({ postId: { $in: postIds }, userId: req.user.id }).lean();
  const likeMap = Object.fromEntries(likeCounts.map(l => [l._id, l.count]));
  const likedSet = new Set(myLikes.map(l => l.postId));

  res.json(rows.map(r => ({
    id: r.id, caption: r.caption, createdAt: r.created_at, mediaType: r.media_type,
    mediaUrl: `/stream/${r.file_id}/${r.bot_index}`,
    user: { id: r.user_id, username: r.username, avatarUrl: r.avatar_file_id ? `/stream/${r.avatar_file_id}/${r.avatar_bot_index}` : null },
    likes: likeMap[r.id] || 0, liked: likedSet.has(r.id),
  })));
});

app.post('/api/posts', requireAuth, upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Media file is required' });
    const { fileId, messageId, botIndex, mediaType } = await uploadToChannel(
      req.file.buffer, req.file.originalname, req.file.mimetype, req.body.caption || ''
    );
    const { rows } = await pgPool.query(
      `INSERT INTO posts (user_id, file_id, bot_index, message_id, media_type, caption)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [req.user.id, fileId, botIndex, messageId, mediaType, req.body.caption || '']
    );
    res.json({ id: rows[0].id, createdAt: rows[0].created_at, mediaUrl: `/stream/${fileId}/${botIndex}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  const { rows } = await pgPool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
  const post = rows[0];
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Not your post' });
  await deleteFromChannel(post.message_id);
  await pgPool.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
  await Like.deleteMany({ postId: post.id });
  res.json({ ok: true });
});

app.post('/api/posts/:id/like', requireAuth, async (req, res) => {
  const postId = Number(req.params.id);
  const existing = await Like.findOne({ postId, userId: req.user.id });
  if (existing) {
    await Like.deleteOne({ _id: existing._id });
  } else {
    await Like.create({ postId, userId: req.user.id });
    const { rows } = await pgPool.query('SELECT user_id FROM posts WHERE id = $1', [postId]);
    if (rows[0] && rows[0].user_id !== req.user.id) {
      await pgPool.query(
        'INSERT INTO notifications (recipient_id, actor_id, type, post_id) VALUES ($1,$2,$3,$4)',
        [rows[0].user_id, req.user.id, 'like', postId]
      );
    }
  }
  const count = await Like.countDocuments({ postId });
  res.json({ liked: !existing, likes: count });
});

app.post('/api/posts/:id/report', requireAuth, async (req, res) => {
  await pgPool.query(
    'INSERT INTO reports (reporter_id, post_id, reason) VALUES ($1,$2,$3)',
    [req.user.id, req.params.id, req.body.reason || 'unspecified']
  );
  res.json({ ok: true });
});

/* =============================================================================
   STORIES (24h expiry)
============================================================================= */
app.get('/api/stories', requireAuth, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT s.id, s.file_id, s.bot_index, s.bg_theme, s.sticker, s.created_at,
            u.id AS user_id, u.username, u.avatar_file_id, u.avatar_bot_index
     FROM stories s JOIN users u ON u.id = s.user_id
     WHERE s.expires_at > NOW() ORDER BY s.created_at DESC`
  );
  res.json(rows.map(r => ({
    id: r.id, bgTheme: r.bg_theme, sticker: r.sticker, createdAt: r.created_at,
    mediaUrl: r.file_id ? `/stream/${r.file_id}/${r.bot_index}` : null,
    user: { id: r.user_id, username: r.username, avatarUrl: r.avatar_file_id ? `/stream/${r.avatar_file_id}/${r.avatar_bot_index}` : null },
  })));
});

app.post('/api/stories', requireAuth, upload.single('media'), async (req, res) => {
  try {
    let fileId = null, botIndex = 0, messageId = null;
    if (req.file) {
      const uploaded = await uploadToChannel(req.file.buffer, req.file.originalname, req.file.mimetype, 'story');
      fileId = uploaded.fileId; botIndex = uploaded.botIndex; messageId = uploaded.messageId;
    }
    const { rows } = await pgPool.query(
      `INSERT INTO stories (user_id, file_id, bot_index, message_id, bg_theme, sticker)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [req.user.id, fileId, botIndex, messageId, req.body.bgTheme || '', req.body.sticker || '']
    );
    res.json({ id: rows[0].id, createdAt: rows[0].created_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Story upload failed' });
  }
});

// Periodic cleanup of expired stories (also removes them from the Telegram channel)
async function cleanupExpiredStories() {
  const { rows } = await pgPool.query('SELECT id, message_id FROM stories WHERE expires_at <= NOW()');
  for (const s of rows) {
    if (s.message_id) await deleteFromChannel(s.message_id);
  }
  if (rows.length) await pgPool.query('DELETE FROM stories WHERE expires_at <= NOW()');
}
setInterval(cleanupExpiredStories, 15 * 60 * 1000); // every 15 min

/* =============================================================================
   STICKERS (synced from admin via Telegram)
============================================================================= */
app.get('/api/stickers', requireAuth, async (req, res) => {
  const { rows } = await pgPool.query('SELECT id, file_id, bot_index, emoji_label FROM stickers ORDER BY created_at DESC');
  res.json(rows.map(r => ({ id: r.id, emojiLabel: r.emoji_label, url: `/stream/${r.file_id}/0` })));
});

/* =============================================================================
   FOLLOW / SOCIAL GRAPH (MongoDB)
============================================================================= */
app.post('/api/follow/:userId', requireAuth, async (req, res) => {
  const followingId = Number(req.params.userId);
  if (followingId === req.user.id) return res.status(400).json({ error: "Can't follow yourself" });
  const result = await Follow.updateOne(
    { followerId: req.user.id, followingId },
    { $setOnInsert: { followerId: req.user.id, followingId, createdAt: new Date() } },
    { upsert: true }
  );
  if (result.upsertedCount > 0) {
    await pgPool.query(
      'INSERT INTO notifications (recipient_id, actor_id, type) VALUES ($1,$2,$3)',
      [followingId, req.user.id, 'follow']
    );
  }
  res.json({ ok: true });
});

app.delete('/api/follow/:userId', requireAuth, async (req, res) => {
  await Follow.deleteOne({ followerId: req.user.id, followingId: Number(req.params.userId) });
  res.json({ ok: true });
});

app.get('/api/profile/:username', requireAuth, async (req, res) => {
  const { rows } = await pgPool.query('SELECT id, username, bio, avatar_file_id, avatar_bot_index, is_private FROM users WHERE username = $1', [req.params.username.toLowerCase()]);
  const profile = rows[0];
  if (!profile) return res.status(404).json({ error: 'User not found' });
  const [followers, following, postRows, isFollowing] = await Promise.all([
    Follow.countDocuments({ followingId: profile.id }),
    Follow.countDocuments({ followerId: profile.id }),
    pgPool.query('SELECT id, file_id, bot_index, media_type FROM posts WHERE user_id = $1 ORDER BY created_at DESC', [profile.id]),
    Follow.exists({ followerId: req.user.id, followingId: profile.id }),
  ]);
  res.json({
    id: profile.id, username: profile.username, bio: profile.bio, isPrivate: profile.is_private,
    avatarUrl: profile.avatar_file_id ? `/stream/${profile.avatar_file_id}/${profile.avatar_bot_index}` : null,
    followers, following, isFollowing: !!isFollowing,
    posts: postRows.rows.map(p => ({ id: p.id, mediaUrl: `/stream/${p.file_id}/${p.bot_index}`, mediaType: p.media_type })),
  });
});

/* =============================================================================
   DIRECT MESSAGES (Neon)
============================================================================= */
app.get('/api/messages/:withUserId', requireAuth, async (req, res) => {
  const otherId = Number(req.params.withUserId);
  const { rows } = await pgPool.query(
    `SELECT * FROM messages WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)
     ORDER BY created_at ASC LIMIT 200`,
    [req.user.id, otherId]
  );
  await pgPool.query('UPDATE messages SET read = TRUE WHERE receiver_id=$1 AND sender_id=$2', [req.user.id, otherId]);
  res.json(rows.map(m => ({ id: m.id, from: m.sender_id === req.user.id ? 'me' : 'them', body: m.body, createdAt: m.created_at })));
});

app.post('/api/messages/:withUserId', requireAuth, async (req, res) => {
  const otherId = Number(req.params.withUserId);
  const blocked = await pgPool.query(
    'SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)',
    [req.user.id, otherId]
  );
  if (blocked.rows[0]) return res.status(403).json({ error: 'Messaging unavailable between these accounts' });
  const { rows } = await pgPool.query(
    'INSERT INTO messages (sender_id, receiver_id, body) VALUES ($1,$2,$3) RETURNING id, created_at',
    [req.user.id, otherId, req.body.body]
  );
  res.json({ id: rows[0].id, createdAt: rows[0].created_at });
});

// Lists every DM thread the current user is part of, most recent first —
// powers the "Signals" (DM list) screen in the frontend.
app.get('/api/conversations', requireAuth, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT DISTINCT ON (other_id) other_id, u.username, u.avatar_file_id, u.avatar_bot_index, m.body, m.created_at
     FROM (
       SELECT CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS other_id, body, created_at
       FROM messages WHERE sender_id = $1 OR receiver_id = $1
     ) m
     JOIN users u ON u.id = m.other_id
     ORDER BY other_id, m.created_at DESC`,
    [req.user.id]
  );
  rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(rows.map(r => ({
    userId: r.other_id, username: r.username,
    avatarUrl: r.avatar_file_id ? `/stream/${r.avatar_file_id}/${r.avatar_bot_index}` : null,
    lastMessage: r.body, lastAt: r.created_at,
  })));
});

// Simple username search — powers the Explore search bar and "start a new chat".
app.get('/api/users/search', requireAuth, async (req, res) => {
  const q = `%${String(req.query.q || '').toLowerCase()}%`;
  const { rows } = await pgPool.query(
    'SELECT id, username, avatar_file_id, avatar_bot_index FROM users WHERE username LIKE $1 AND id != $2 LIMIT 20',
    [q, req.user.id]
  );
  res.json(rows.map(r => ({ id: r.id, username: r.username, avatarUrl: r.avatar_file_id ? `/stream/${r.avatar_file_id}/${r.avatar_bot_index}` : null })));
});

/* =============================================================================
   NOTIFICATIONS (Activity tab)
============================================================================= */
app.get('/api/notifications', requireAuth, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT n.id, n.type, n.read, n.created_at, n.post_id,
            a.username AS actor_username, a.avatar_file_id AS actor_avatar_file_id, a.avatar_bot_index AS actor_avatar_bot_index,
            p.file_id AS post_file_id, p.bot_index AS post_bot_index
     FROM notifications n
     JOIN users a ON a.id = n.actor_id
     LEFT JOIN posts p ON p.id = n.post_id
     WHERE n.recipient_id = $1
     ORDER BY n.created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(rows.map(r => ({
    id: r.id, type: r.type, read: r.read, createdAt: r.created_at,
    actor: { username: r.actor_username, avatarUrl: r.actor_avatar_file_id ? `/stream/${r.actor_avatar_file_id}/${r.actor_avatar_bot_index}` : null },
    postThumb: r.post_file_id ? `/stream/${r.post_file_id}/${r.post_bot_index}` : null,
  })));
});

app.post('/api/notifications/read', requireAuth, async (req, res) => {
  await pgPool.query('UPDATE notifications SET read = TRUE WHERE recipient_id = $1 AND read = FALSE', [req.user.id]);
  res.json({ ok: true });
});

/* =============================================================================
   EXPLORE / DISCOVER
   Trending posts ranked by a recency-weighted like score, plus a "suggested
   accounts to follow" row — this is what powers real discovery instead of
   just mirroring the home feed.
============================================================================= */
app.get('/api/explore/posts', requireAuth, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT p.id, p.file_id, p.bot_index, p.media_type, p.caption, p.created_at,
            u.id AS user_id, u.username, u.avatar_file_id, u.avatar_bot_index
     FROM posts p JOIN users u ON u.id = p.user_id
     WHERE p.created_at > NOW() - INTERVAL '7 days' AND p.user_id != $1
     ORDER BY p.created_at DESC LIMIT 200`,
    [req.user.id]
  );
  const postIds = rows.map(r => r.id);
  const likeCounts = await Like.aggregate([
    { $match: { postId: { $in: postIds } } },
    { $group: { _id: '$postId', count: { $sum: 1 } } },
  ]);
  const likeMap = Object.fromEntries(likeCounts.map(l => [l._id, l.count]));

  const scored = rows.map(r => {
    const ageHours = Math.max(1, (Date.now() - new Date(r.created_at)) / 36e5);
    const likes = likeMap[r.id] || 0;
    // Recency-weighted score: fresh posts with engagement float to the top,
    // but a strong burst of likes can still surface an older post.
    const score = likes / Math.pow(ageHours + 2, 1.5);
    return { r, likes, score };
  }).sort((a, b) => b.score - a.score).slice(0, 30);

  res.json(scored.map(({ r, likes }) => ({
    id: r.id, caption: r.caption, mediaType: r.media_type, createdAt: r.created_at,
    mediaUrl: `/stream/${r.file_id}/${r.bot_index}`,
    user: { id: r.user_id, username: r.username, avatarUrl: r.avatar_file_id ? `/stream/${r.avatar_file_id}/${r.avatar_bot_index}` : null },
    likes,
  })));
});

app.get('/api/explore/users', requireAuth, async (req, res) => {
  const alreadyFollowing = await Follow.find({ followerId: req.user.id }).lean();
  const excludeIds = new Set([req.user.id, ...alreadyFollowing.map(f => f.followingId)]);

  const followerCounts = await Follow.aggregate([{ $group: { _id: '$followingId', count: { $sum: 1 } } }]);
  const ranked = followerCounts.filter(f => !excludeIds.has(f._id)).sort((a, b) => b.count - a.count).slice(0, 15);
  const ids = ranked.map(r => r._id);

  let candidates = [];
  if (ids.length) {
    const { rows } = await pgPool.query('SELECT id, username, avatar_file_id, avatar_bot_index FROM users WHERE id = ANY($1)', [ids]);
    candidates = rows;
  }
  // Backfill with recently-joined accounts if the graph is too sparse to rank yet.
  if (candidates.length < 8) {
    const { rows } = await pgPool.query(
      'SELECT id, username, avatar_file_id, avatar_bot_index FROM users WHERE id != ALL($1) ORDER BY created_at DESC LIMIT 15',
      [[...excludeIds]]
    );
    const seen = new Set(candidates.map(c => c.id));
    candidates = candidates.concat(rows.filter(r => !seen.has(r.id)));
  }

  const followerMap = Object.fromEntries(followerCounts.map(f => [f._id, f.count]));
  res.json(candidates.slice(0, 15).map(u => ({
    id: u.id, username: u.username, followers: followerMap[u.id] || 0,
    avatarUrl: u.avatar_file_id ? `/stream/${u.avatar_file_id}/${u.avatar_bot_index}` : null,
  })));
});

/* =============================================================================
   ADMIN DASHBOARD (web) — mirrors the Telegram admin-bot commands as REST
============================================================================= */
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const [users, posts, stories, reports] = await Promise.all([
    pgPool.query('SELECT COUNT(*) FROM users'),
    pgPool.query('SELECT COUNT(*) FROM posts'),
    pgPool.query("SELECT COUNT(*) FROM stories WHERE expires_at > NOW()"),
    pgPool.query('SELECT COUNT(*) FROM reports WHERE resolved = FALSE'),
  ]);
  res.json({
    users: Number(users.rows[0].count), posts: Number(posts.rows[0].count),
    activeStories: Number(stories.rows[0].count), openReports: Number(reports.rows[0].count),
    botPoolSize: allBots.length,
  });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const q = `%${String(req.query.q || '').toLowerCase()}%`;
  const { rows } = await pgPool.query(
    `SELECT id, username, telegram_id, is_banned, is_admin, created_at FROM users
     WHERE username LIKE $1 ORDER BY created_at DESC LIMIT 50`,
    [q]
  );
  res.json(rows);
});

app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  await pgPool.query('UPDATE users SET is_banned = TRUE WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});
app.post('/api/admin/users/:id/unban', requireAdmin, async (req, res) => {
  await pgPool.query('UPDATE users SET is_banned = FALSE WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/admin/users/:id/inspect', requireAdmin, async (req, res) => {
  const { rows } = await pgPool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: 'User not found' });
  const [postCount, followers, following] = await Promise.all([
    pgPool.query('SELECT COUNT(*) FROM posts WHERE user_id=$1', [u.id]),
    Follow.countDocuments({ followingId: u.id }),
    Follow.countDocuments({ followerId: u.id }),
  ]);
  res.json({
    id: u.id, username: u.username, telegramId: u.telegram_id, isBanned: u.is_banned,
    isAdmin: u.is_admin, isPrivate: u.is_private, createdAt: u.created_at,
    posts: Number(postCount.rows[0].count), followers, following,
  });
});

app.get('/api/admin/reports', requireAdmin, async (req, res) => {
  const { rows } = await pgPool.query(
    `SELECT r.id, r.reason, r.created_at, r.post_id,
            reporter.username AS reporter_username,
            p.caption, p.file_id, p.bot_index, p.media_type,
            owner.username AS post_owner
     FROM reports r
     JOIN users reporter ON reporter.id = r.reporter_id
     LEFT JOIN posts p ON p.id = r.post_id
     LEFT JOIN users owner ON owner.id = p.user_id
     WHERE r.resolved = FALSE ORDER BY r.created_at DESC LIMIT 50`
  );
  res.json(rows.map(r => ({
    id: r.id, reason: r.reason, createdAt: r.created_at, reporterUsername: r.reporter_username,
    post: r.post_id ? {
      id: r.post_id, caption: r.caption, owner: r.post_owner,
      mediaUrl: r.file_id ? `/stream/${r.file_id}/${r.bot_index}` : null, mediaType: r.media_type,
    } : null,
  })));
});

app.post('/api/admin/reports/:id/resolve', requireAdmin, async (req, res) => {
  await pgPool.query('UPDATE reports SET resolved = TRUE WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
  const message = req.body.message;
  if (!message) return res.status(400).json({ error: 'Message is required' });
  const { rows } = await pgPool.query('SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL AND is_banned = FALSE');
  res.json({ queued: rows.length }); // respond immediately, send in the background
  for (const u of rows) {
    try {
      await mainBot.telegram.sendMessage(u.telegram_id, `📣 ECHO announcement:\n\n${message}`);
      await new Promise(r => setTimeout(r, 60));
    } catch { /* user may have blocked the bot */ }
  }
});

app.get('/api/admin/chat', requireAdmin, async (req, res) => {
  const { user1, user2 } = req.query;
  if (!user1 || !user2) return res.status(400).json({ error: 'user1 and user2 query params are required' });
  const { rows: users } = await pgPool.query('SELECT id, username FROM users WHERE username = ANY($1)', [[user1.toLowerCase(), user2.toLowerCase()]]);
  if (users.length < 2) return res.status(404).json({ error: 'One or both users not found' });
  const [a, b] = users;
  const { rows: msgs } = await pgPool.query(
    `SELECT sender_id, body, created_at FROM messages
     WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)
     ORDER BY created_at ASC LIMIT 200`,
    [a.id, b.id]
  );
  res.json(msgs.map(m => ({ from: m.sender_id === a.id ? a.username : b.username, body: m.body, createdAt: m.created_at })));
});

/* =============================================================================
   FILE STREAMING (proxies the media straight from Telegram's CDN)
============================================================================= */
app.get('/stream/:fileId/:botIndex', async (req, res) => {
  try {
    await streamTelegramFile(req.params.fileId, Number(req.params.botIndex) || 0, res);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Failed to stream media' });
  }
});

/* =============================================================================
   ADMIN BOT — restricted exclusively to ADMIN_TELEGRAM_ID
============================================================================= */
mainBot.use(async (ctx, next) => {
  const adminCommands = ['stats', 'ban', 'inspect', 'readchat', 'reports', 'deletepost', 'broadcast'];
  const cmd = ctx.message?.text?.startsWith('/') ? ctx.message.text.slice(1).split(' ')[0] : null;
  if (adminCommands.includes(cmd) && String(ctx.from.id) !== ADMIN_TELEGRAM_ID) {
    return; // silently ignore — command is invisible to anyone but the owner
  }
  return next();
});

mainBot.start((ctx) => ctx.reply('Welcome to ECHO. Link your Telegram to your web account from Settings → Security.'));

mainBot.command('stats', async (ctx) => {
  const [users, posts, stories] = await Promise.all([
    pgPool.query('SELECT COUNT(*) FROM users'),
    pgPool.query('SELECT COUNT(*) FROM posts'),
    pgPool.query('SELECT COUNT(*) FROM stories WHERE expires_at > NOW()'),
  ]);
  ctx.reply(
    `📊 ECHO Stats\n` +
    `Users: ${users.rows[0].count}\n` +
    `Posts (storage units): ${posts.rows[0].count}\n` +
    `Active stories: ${stories.rows[0].count}\n` +
    `Bot pool size: ${allBots.length}`
  );
});

mainBot.command('ban', async (ctx) => {
  const username = ctx.message.text.split(' ')[1]?.replace('@', '');
  if (!username) return ctx.reply('Usage: /ban @username');
  const { rowCount } = await pgPool.query('UPDATE users SET is_banned = TRUE WHERE username = $1', [username.toLowerCase()]);
  ctx.reply(rowCount ? `🚫 @${username} has been banned.` : `User @${username} not found.`);
});

mainBot.command('inspect', async (ctx) => {
  const username = ctx.message.text.split(' ')[1]?.replace('@', '');
  if (!username) return ctx.reply('Usage: /inspect @username');
  const { rows } = await pgPool.query('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
  const u = rows[0];
  if (!u) return ctx.reply('User not found.');
  const [postCount, followers, following] = await Promise.all([
    pgPool.query('SELECT COUNT(*) FROM posts WHERE user_id=$1', [u.id]),
    Follow.countDocuments({ followingId: u.id }),
    Follow.countDocuments({ followerId: u.id }),
  ]);
  ctx.reply(
    `🔍 @${u.username} (id ${u.id})\n` +
    `Telegram ID: ${u.telegram_id || 'not linked'}\n` +
    `Posts: ${postCount.rows[0].count} | Followers: ${followers} | Following: ${following}\n` +
    `Banned: ${u.is_banned} | Private: ${u.is_private}\n` +
    `Joined: ${u.created_at.toISOString()}`
  );
});

mainBot.command('readchat', async (ctx) => {
  const parts = ctx.message.text.split(' ').slice(1).map(s => s.replace('@', ''));
  if (parts.length < 2) return ctx.reply('Usage: /readchat @user1 @user2');
  const { rows: users } = await pgPool.query('SELECT id, username FROM users WHERE username = ANY($1)', [parts.map(p => p.toLowerCase())]);
  if (users.length < 2) return ctx.reply('One or both users not found.');
  const [a, b] = users;
  const { rows: msgs } = await pgPool.query(
    `SELECT sender_id, body, created_at FROM messages
     WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)
     ORDER BY created_at ASC LIMIT 100`,
    [a.id, b.id]
  );
  if (!msgs.length) return ctx.reply('No messages between these two users.');
  const text = msgs.map(m => `${m.sender_id === a.id ? a.username : b.username}: ${m.body}`).join('\n');
  ctx.reply(`💬 ${a.username} ↔ ${b.username}\n\n${text}`.slice(0, 4000));
});

mainBot.command('reports', async (ctx) => {
  const { rows } = await pgPool.query(
    `SELECT r.id, r.reason, r.post_id, u.username AS reporter, r.created_at
     FROM reports r JOIN users u ON u.id = r.reporter_id
     WHERE r.resolved = FALSE ORDER BY r.created_at DESC LIMIT 20`
  );
  if (!rows.length) return ctx.reply('No open reports. 🎉');
  const text = rows.map(r => `#${r.id} — post ${r.post_id} reported by @${r.reporter}: ${r.reason}`).join('\n');
  ctx.reply(`🚩 Open reports\n\n${text}`);
});

mainBot.command('deletepost', async (ctx) => {
  const postId = Number(ctx.message.text.split(' ')[1]);
  if (!postId) return ctx.reply('Usage: /deletepost <post_id>');
  const { rows } = await pgPool.query('SELECT * FROM posts WHERE id = $1', [postId]);
  if (!rows[0]) return ctx.reply('Post not found.');
  await deleteFromChannel(rows[0].message_id);
  await pgPool.query('DELETE FROM posts WHERE id = $1', [postId]);
  await Like.deleteMany({ postId });
  ctx.reply(`🗑️ Post #${postId} removed from the database and the storage channel.`);
});

mainBot.command('broadcast', async (ctx) => {
  const text = ctx.message.text.split(' ').slice(1).join(' ');
  if (!text) return ctx.reply('Usage: /broadcast <message>');
  const { rows } = await pgPool.query('SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL AND is_banned = FALSE');
  ctx.reply(`📣 Broadcasting to ${rows.length} users…`);
  for (const u of rows) {
    try {
      await mainBot.telegram.sendMessage(u.telegram_id, `📣 ECHO announcement:\n\n${text}`);
      await new Promise(r => setTimeout(r, 60)); // stay well under Telegram's rate limits
    } catch (e) { /* user may have blocked the bot — skip */ }
  }
  ctx.reply('✅ Broadcast complete.');
});

// Automated sticker sync: admin forwards/sends any sticker to the bot, and it's
// instantly captured into the stickers table for the web app's story drawer.
mainBot.on('sticker', async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_TELEGRAM_ID) return;
  const sticker = ctx.message.sticker;
  await pgPool.query(
    'INSERT INTO stickers (file_id, emoji_label) VALUES ($1,$2)',
    [sticker.file_id, sticker.emoji || '']
  );
  ctx.reply(`✨ Sticker ${sticker.emoji || ''} synced to the web app.`);
});

mainBot.catch((err, ctx) => {
  console.error(`Bot error [${ctx.updateType}]:`, err);
});

/* =============================================================================
   STARTUP
============================================================================= */
async function main() {
  await initPostgres();
  await initMongo();

  if (RUN_MODE === 'webhook') {
    if (!WEBHOOK_URL) throw new Error('WEBHOOK_URL is required when RUN_MODE=webhook');
    const secretPath = `/telegraf/${crypto.randomBytes(24).toString('hex')}`;
    app.use(mainBot.webhookCallback(secretPath));
    await mainBot.telegram.setWebhook(`${WEBHOOK_URL}${secretPath}`);
    console.log(`✅ Webhook set at ${WEBHOOK_URL}${secretPath}`);
  } else {
    await mainBot.telegram.deleteWebhook().catch(() => {});
    mainBot.launch();
    console.log('✅ Main bot launched in polling mode');
  }

  app.listen(PORT, () => console.log(`🌐 Server listening on port ${PORT}`));
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});

process.once('SIGINT', () => { mainBot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  mainBot.stop('SIGTERM');
  pgPool.end();
  mongoose.disconnect();
  process.exit(0);
});

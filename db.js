// db.js — Neon (PostgreSQL) connection pool + all query helpers.
// Every DB call the bot needs lives here so handlers stay clean.

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required by Neon
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected PG pool error:', err);
});

async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('✅ Schema ensured (Neon DB ready)');
}

// ---------- USERS ----------

async function getUserByTelegramId(telegramId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getUserByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  return rows[0] || null;
}

async function createUser(telegramId, telegramUsername, firstName) {
  const { rows } = await pool.query(
    `INSERT INTO users (telegram_id, telegram_username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE SET telegram_username = EXCLUDED.telegram_username
     RETURNING *`,
    [telegramId, telegramUsername || null, firstName || null]
  );
  return rows[0];
}

async function setUsername(userId, username) {
  const { rows } = await pool.query(
    `UPDATE users SET username = $2, reg_step = 'ask_avatar' WHERE id = $1 RETURNING *`,
    [userId, username]
  );
  return rows[0];
}

async function setBio(userId, bio) {
  await pool.query('UPDATE users SET bio = $2 WHERE id = $1', [userId, bio]);
}

async function setAvatar(userId, fileId, channelMsgId) {
  const { rows } = await pool.query(
    `UPDATE users SET avatar_file_id = $2, avatar_channel_msg_id = $3, reg_step = 'done' WHERE id = $1 RETURNING *`,
    [userId, fileId, channelMsgId]
  );
  return rows[0];
}

async function touchLastActive(userId) {
  await pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [userId]);
}

async function banUser(userId, reason) {
  await pool.query('UPDATE users SET is_banned = TRUE, ban_reason = $2 WHERE id = $1', [userId, reason || 'No reason given']);
}

async function unbanUser(userId) {
  await pool.query('UPDATE users SET is_banned = FALSE, ban_reason = NULL WHERE id = $1', [userId]);
}

// Random profile for "Explore", excluding self and banned users
async function getRandomProfile(excludeUserId) {
  const { rows } = await pool.query(
    `SELECT * FROM users
     WHERE id != $1 AND is_banned = FALSE AND reg_step = 'done'
     ORDER BY RANDOM() LIMIT 1`,
    [excludeUserId]
  );
  return rows[0] || null;
}

// ---------- REACTIONS (like / dislike) ----------

async function toggleReaction(actorId, targetId, type) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT * FROM reactions WHERE actor_id = $1 AND target_id = $2',
      [actorId, targetId]
    );

    let result = 'added';

    if (existing.rows.length === 0) {
      await client.query(
        'INSERT INTO reactions (actor_id, target_id, reaction_type) VALUES ($1, $2, $3)',
        [actorId, targetId, type]
      );
      await client.query(
        `UPDATE users SET ${type === 'like' ? 'like_count' : 'dislike_count'} = ${type === 'like' ? 'like_count' : 'dislike_count'} + 1 WHERE id = $1`,
        [targetId]
      );
    } else if (existing.rows[0].reaction_type === type) {
      // same reaction tapped again -> remove (toggle off)
      await client.query('DELETE FROM reactions WHERE actor_id = $1 AND target_id = $2', [actorId, targetId]);
      await client.query(
        `UPDATE users SET ${type === 'like' ? 'like_count' : 'dislike_count'} = GREATEST(${type === 'like' ? 'like_count' : 'dislike_count'} - 1, 0) WHERE id = $1`,
        [targetId]
      );
      result = 'removed';
    } else {
      // switching like<->dislike
      await client.query(
        'UPDATE reactions SET reaction_type = $3 WHERE actor_id = $1 AND target_id = $2',
        [actorId, targetId, type]
      );
      const oldType = existing.rows[0].reaction_type;
      await client.query(
        `UPDATE users SET ${oldType === 'like' ? 'like_count' : 'dislike_count'} = GREATEST(${oldType === 'like' ? 'like_count' : 'dislike_count'} - 1, 0),
                           ${type === 'like' ? 'like_count' : 'dislike_count'} = ${type === 'like' ? 'like_count' : 'dislike_count'} + 1
         WHERE id = $1`,
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

// ---------- FOLLOWS ----------

async function toggleFollow(followerId, followingId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT * FROM follows WHERE follower_id = $1 AND following_id = $2',
      [followerId, followingId]
    );

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

async function isFollowing(followerId, followingId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
    [followerId, followingId]
  );
  return rows.length > 0;
}

async function getUserReaction(actorId, targetId) {
  const { rows } = await pool.query(
    'SELECT reaction_type FROM reactions WHERE actor_id = $1 AND target_id = $2',
    [actorId, targetId]
  );
  return rows[0]?.reaction_type || null;
}

// ---------- MESSAGES ----------

async function saveMessage(senderId, receiverId, content) {
  await pool.query(
    'INSERT INTO messages (sender_id, receiver_id, content) VALUES ($1, $2, $3)',
    [senderId, receiverId, content]
  );
}

// ---------- REPORTS ----------

async function createReport(reporterId, reportedId, reason) {
  await pool.query(
    'INSERT INTO reports (reporter_id, reported_id, reason) VALUES ($1, $2, $3)',
    [reporterId, reportedId, reason]
  );
}

// ---------- ADMIN / STATS ----------

async function getStats() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COUNT(*) FROM users WHERE is_banned = TRUE) AS banned_users,
      (SELECT COUNT(*) FROM users WHERE last_active > NOW() - INTERVAL '24 hours') AS active_24h,
      (SELECT COUNT(*) FROM users WHERE reg_step != 'done') AS incomplete_registrations,
      (SELECT COUNT(*) FROM reactions WHERE reaction_type = 'like') AS total_likes,
      (SELECT COUNT(*) FROM follows) AS total_follows,
      (SELECT COUNT(*) FROM messages) AS total_messages,
      (SELECT COUNT(*) FROM reports WHERE status = 'open') AS open_reports
  `);
  return rows[0];
}

async function getAllTelegramIds() {
  const { rows } = await pool.query("SELECT telegram_id FROM users WHERE is_banned = FALSE");
  return rows.map(r => r.telegram_id);
}

async function searchUsers(query) {
  const { rows } = await pool.query(
    `SELECT * FROM users
     WHERE LOWER(username) LIKE LOWER($1)
        OR LOWER(telegram_username) LIKE LOWER($1)
        OR telegram_id::TEXT = $2
     LIMIT 10`,
    [`%${query}%`, query]
  );
  return rows;
}

module.exports = {
  pool,
  initSchema,
  getUserByTelegramId,
  getUserById,
  getUserByUsername,
  createUser,
  setUsername,
  setBio,
  setAvatar,
  touchLastActive,
  banUser,
  unbanUser,
  getRandomProfile,
  toggleReaction,
  toggleFollow,
  isFollowing,
  getUserReaction,
  saveMessage,
  createReport,
  getStats,
  getAllTelegramIds,
  searchUsers,
};

-- ============================================================
-- Telegram Social Media Bot — Neon (PostgreSQL) Schema
-- Run once (index.js also auto-runs this on boot, idempotent)
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id                     BIGSERIAL PRIMARY KEY,
  telegram_id            BIGINT UNIQUE NOT NULL,      -- REAL telegram id (private, never shown publicly)
  telegram_username      VARCHAR(64),                 -- REAL @handle (private, admin-only)
  first_name             VARCHAR(128),
  username               VARCHAR(32) UNIQUE,          -- public custom username shown to everyone
  bio                     TEXT DEFAULT '',
  avatar_file_id         TEXT,                        -- telegram file_id (fast resend, no re-upload)
  avatar_channel_msg_id  BIGINT,                       -- backup reference: message id in private channel
  like_count             INT DEFAULT 0,
  dislike_count          INT DEFAULT 0,
  follower_count         INT DEFAULT 0,
  following_count        INT DEFAULT 0,
  is_banned              BOOLEAN DEFAULT FALSE,
  ban_reason             TEXT,
  is_admin               BOOLEAN DEFAULT FALSE,
  reg_step               VARCHAR(32) DEFAULT 'ask_username', -- registration wizard state
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  last_active            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reactions (
  id            BIGSERIAL PRIMARY KEY,
  actor_id      BIGINT REFERENCES users(id) ON DELETE CASCADE,
  target_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  reaction_type VARCHAR(8) CHECK (reaction_type IN ('like','dislike')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(actor_id, target_id)
);

CREATE TABLE IF NOT EXISTS follows (
  id            BIGSERIAL PRIMARY KEY,
  follower_id   BIGINT REFERENCES users(id) ON DELETE CASCADE,
  following_id  BIGINT REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(follower_id, following_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id            BIGSERIAL PRIMARY KEY,
  sender_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  receiver_id   BIGINT REFERENCES users(id) ON DELETE CASCADE,
  content       TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reports (
  id            BIGSERIAL PRIMARY KEY,
  reporter_id   BIGINT REFERENCES users(id) ON DELETE CASCADE,
  reported_id   BIGINT REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT,
  status        VARCHAR(16) DEFAULT 'open',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id  ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_username      ON users(username);
CREATE INDEX IF NOT EXISTS idx_reactions_target     ON reactions(target_id);
CREATE INDEX IF NOT EXISTS idx_reactions_actor       ON reactions(actor_id);
CREATE INDEX IF NOT EXISTS idx_follows_following     ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower       ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver      ON messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_reports_status         ON reports(status);

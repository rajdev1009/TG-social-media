# 🤖 Telegram Social Media Bot — Single File Edition

Everything (bot logic, both database layers, keyboards, admin panel) lives in
**one file: `index.js`**. Only `package.json` and `.env.example` sit beside it
— those aren't code, just project config, so the structure stays flat.

## 📁 Files
- `index.js` — the entire bot
- `package.json` — dependencies
- `.env.example` — environment variable template

## 🧠 Dual Database Design
| Database | Stores | Why |
|---|---|---|
| **Neon (PostgreSQL)** | `users`, `reactions` (like/dislike), `follows` | Relational, transactional counters — likes/follows toggle safely under concurrent taps. |
| **MongoDB** | `messages` (text/voice/audio), `reports`, `admin_logs` | High-volume, flexible/append-only — no schema migration needed as message types grow. |

Both connect on boot; if either `DATABASE_URL` or `MONGODB_URI` is missing or
unreachable, the bot refuses to start (fails loudly instead of silently
running half-broken).

## 🔐 Private Channel Media Storage
Every avatar photo **and every voice/audio DM** is forwarded into
`PRIVATE_CHANNEL_ID` via `archiveToChannel()`. Only the Telegram `file_id`
(+ the channel `message_id` as a backup pointer) is saved in the database —
never raw bytes. This keeps both databases tiny and media loads instant,
since Telegram serves the file directly from its own CDN via `file_id`.

## 🎙 Voice & Audio in DMs
When a user taps **💬 Message** on a profile, the next message they send can
be **text, a voice note, or an audio file** — all three are detected
(`bot.on('text')`, `bot.on('voice')`, `bot.on('audio')`), archived to the
private channel, logged in MongoDB with `media_type`, and delivered to the
recipient using `sendVoice` / `sendAudio` with the same `file_id` (fast,
no re-upload). The admin gets a real-identity-mapped notification for every
DM regardless of media type.

## 🕵️ Privacy Layer
- Public-facing: only `username` (custom, user-chosen) + avatar.
- Admin-facing only: `telegram_id` + `telegram_username` (real identity),
  sent via `notifyAdmin()` on signup, every DM (text/voice/audio), and every
  report — for safety and abuse tracking. Never exposed to other users.

## 🛠 Admin Panel (`/admin`)
Restricted to `ADMIN_ID` only (silently ignored for anyone else — the panel's
existence isn't revealed). All flows run through **one unified text handler**
in `index.js` so there's no middleware-ordering ambiguity between admin flows
and normal user flows (this was the source of bugs in the multi-file version):
- 📊 **Stats** — combined Postgres + MongoDB dashboard (users, likes, follows, messages by type, open reports).
- 🔍 **Inspect** — look up any user by username / @handle / numeric id, see real identity + activity.
- 🚫 / ✅ **Ban / Unban** — with reason logging.
- 📢 **Broadcast** — rate-limited send to every non-banned user, with sent/failed counts.
- Every ban/unban/broadcast is also written to MongoDB's `admin_logs` collection for an audit trail.

## 🚀 Setup

### 1. Telegram Bot & Admin
- [@BotFather](https://t.me/BotFather) → `/newbot` → `BOT_TOKEN`.
- [@userinfobot](https://t.me/userinfobot) → your numeric id → `ADMIN_ID`.

### 2. Private Channel
- Create a **private** channel, add the bot as **admin** (needs post-message permission).
- Get its id (looks like `-100...`) → `PRIVATE_CHANNEL_ID`.

### 3. Neon (PostgreSQL)
- Create a project at [neon.tech](https://neon.tech), copy the **pooled connection string** → `DATABASE_URL`.
- Schema auto-creates on boot — no manual migration step.

### 4. MongoDB
- Create a free cluster at [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
- Copy the connection string, make sure it includes a database name (e.g. `.../telegram_social_bot?...`) → `MONGODB_URI`.
- Collections + indexes auto-create on boot.

### 5. Local run
```bash
npm install
cp .env.example .env   # fill in real values, set RUN_MODE=polling
npm start
```

### 6. Deploy on Render
1. Push `index.js`, `package.json`, `.env.example` to a GitHub repo (flat — no folders needed).
2. Render → New → Web Service → connect the repo.
3. Build command: `npm install` · Start command: `npm start`.
4. Environment variables (Render dashboard):
   - `BOT_TOKEN`, `DATABASE_URL`, `MONGODB_URI`, `ADMIN_ID`, `PRIVATE_CHANNEL_ID`
   - `WEBHOOK_URL` → `https://<your-render-service>.onrender.com`
   - `RUN_MODE` → `webhook`
5. Deploy. Webhook mode means Telegram queues updates while the free-tier instance is asleep — nothing is lost, it's just delayed until the next request wakes it.

## 💡 Still-open ideas for next iteration
- Mutual-like "match" auto-notify (both users like each other → unlock DMs).
- `/top` leaderboard from Postgres counters.
- Per-user rate limiting on DMs/likes (Mongo TTL collection or Redis).
- Route voice/audio through an image/audio moderation API before archiving.

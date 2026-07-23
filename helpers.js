// helpers.js — small shared utilities: formatting, validation, admin logging.

function escapeMd(text = '') {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function isValidUsername(username) {
  // 3-20 chars, letters/numbers/underscore only, must start with a letter
  return /^[a-zA-Z][a-zA-Z0-9_]{2,19}$/.test(username);
}

function profileCaption(user, { isSelf = false, viewerIsAdmin = false } = {}) {
  const lines = [];
  lines.push(`*${escapeMd(user.username || 'unnamed')}*`);
  if (user.bio) lines.push(escapeMd(user.bio));
  lines.push('');
  lines.push(`❤️ ${user.like_count}   👎 ${user.dislike_count}   👥 ${user.follower_count} followers`);
  if (isSelf) {
    lines.push('');
    lines.push(`_This is how others see your profile\\._`);
  }
  return lines.join('\n');
}

// Sends a safety/tracking log to the admin — maps the public custom identity
// back to the REAL Telegram id + handle. Never shown to normal users.
async function notifyAdmin(bot, adminId, text) {
  if (!adminId) return;
  try {
    await bot.telegram.sendMessage(adminId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Failed to notify admin:', e.message);
  }
}

function realIdTag(user) {
  const handle = user.telegram_username ? `@${user.telegram_username}` : '(no public @handle)';
  return `ID: \`${user.telegram_id}\` ${escapeMd(handle)}`;
}

module.exports = { escapeMd, isValidUsername, profileCaption, notifyAdmin, realIdTag };

// moderation.js — lightweight automated moderation.
// Not a replacement for human review, but catches obvious spam/abuse
// before it reaches another user, and flags it for the admin.

const BLOCKED_PATTERNS = [
  /\bt\.me\/\S+/i,          // telegram invite links (anti-spam)
  /\bhttps?:\/\/\S+/i,      // raw links in DMs
  /\b(viagra|crypto\s*airdrop|free\s*followers)\b/i,
];

function isSuspicious(text = '') {
  return BLOCKED_PATTERNS.some((re) => re.test(text));
}

function containsBannedWord(text = '', bannedWords = []) {
  const lower = text.toLowerCase();
  return bannedWords.some((w) => lower.includes(w.toLowerCase()));
}

module.exports = { isSuspicious, containsBannedWord };

// keyboards.js — all reply keyboards + inline keyboards in one place.

const { Markup } = require('telegraf');

function mainMenu(isAdmin) {
  const rows = [
    ['🔀 Explore', '👤 My Profile'],
    ['✉️ Messages', '⚙️ Settings'],
  ];
  if (isAdmin) rows.push(['🛠 Admin Panel']);
  return Markup.keyboard(rows).resize();
}

function profileInlineKeyboard(targetDbId, { liked, disliked, following, likeCount, dislikeCount, isSelf }) {
  if (isSelf) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Edit Bio', 'edit_bio'), Markup.button.callback('🖼 Change Avatar', 'edit_avatar')],
      [Markup.button.callback('🔀 Explore Others', 'explore_next:0')],
    ]);
  }

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`${liked ? '❤️' : '🤍'} Like (${likeCount})`, `like:${targetDbId}`),
      Markup.button.callback(`${disliked ? '💔' : '👎'} Dislike (${dislikeCount})`, `dislike:${targetDbId}`),
    ],
    [
      Markup.button.callback(following ? '➖ Unfollow' : '➕ Follow', `follow:${targetDbId}`),
      Markup.button.callback('💬 Message', `msg:${targetDbId}`),
    ],
    [
      Markup.button.callback('🔀 Next Profile', `explore_next:${targetDbId}`),
      Markup.button.callback('🚩 Report', `report:${targetDbId}`),
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

module.exports = {
  mainMenu,
  profileInlineKeyboard,
  adminDashboardKeyboard,
  cancelInline,
};

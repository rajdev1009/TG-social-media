// adminHandlers.js — /admin panel, restricted to ADMIN_ID only.

const db = require('./db');
const state = require('./state');
const { adminDashboardKeyboard, mainMenu } = require('./keyboards');
const { escapeMd, realIdTag } = require('./helpers');

function register(bot, { adminId }) {
  function isAdmin(ctx) {
    return ctx.from && Number(ctx.from.id) === Number(adminId);
  }

  bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx)) return; // silently ignore — don't reveal the panel exists
    return ctx.reply('🛠 *Admin Panel*', { parse_mode: 'Markdown', ...adminDashboardKeyboard() });
  });

  // catches the "🛠 Admin Panel" reply-keyboard button (routed here via next() in userHandlers)
  bot.hears('🛠 Admin Panel', async (ctx) => {
    if (!isAdmin(ctx)) return;
    return ctx.reply('🛠 *Admin Panel*', { parse_mode: 'Markdown', ...adminDashboardKeyboard() });
  });

  bot.action('admin_stats', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const s = await db.getStats();
    const text = [
      '📊 *Bot Statistics*',
      '',
      `👥 Total users: *${s.total_users}*`,
      `🟢 Active last 24h: *${s.active_24h}*`,
      `🚫 Banned: *${s.banned_users}*`,
      `⏳ Incomplete registrations: *${s.incomplete_registrations}*`,
      `❤️ Total likes: *${s.total_likes}*`,
      `➕ Total follows: *${s.total_follows}*`,
      `✉️ Total messages sent: *${s.total_messages}*`,
      `🚩 Open reports: *${s.open_reports}*`,
    ].join('\n');
    return ctx.reply(text, { parse_mode: 'Markdown' });
  });

  bot.action('admin_inspect', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    state.set(ctx.from.id, { flow: 'admin_inspect' });
    return ctx.reply('🔍 Send a username, @handle, or numeric telegram id to inspect:');
  });

  bot.action('admin_ban', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    state.set(ctx.from.id, { flow: 'admin_ban' });
    return ctx.reply('🚫 Send: `username reason here` to ban a user.', { parse_mode: 'Markdown' });
  });

  bot.action('admin_unban', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    state.set(ctx.from.id, { flow: 'admin_unban' });
    return ctx.reply('✅ Send the username to unban:');
  });

  bot.action('admin_broadcast', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    state.set(ctx.from.id, { flow: 'admin_broadcast' });
    return ctx.reply('📢 Send the message to broadcast to ALL active users:');
  });

  // Admin text-flow router — must run BEFORE userHandlers' generic text handler,
  // so it's registered in index.js prior to userHandlers.register().
  bot.on('text', async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const session = state.get(ctx.from.id);
    if (!session) return next();

    const text = ctx.message.text.trim();

    if (session.flow === 'admin_inspect') {
      state.clear(ctx.from.id);
      const query = text.replace('@', '');
      const results = await db.searchUsers(query);
      if (results.length === 0) return ctx.reply('No matching users found.');

      for (const u of results) {
        const info = [
          `*${escapeMd(u.username || 'unnamed')}* (db id ${u.id})`,
          realIdTag(u),
          `❤️ ${u.like_count} 👎 ${u.dislike_count} 👥 ${u.follower_count} followers`,
          `Banned: ${u.is_banned ? `Yes (${u.ban_reason || 'n/a'})` : 'No'}`,
          `Joined: ${new Date(u.created_at).toDateString()}`,
        ].join('\n');
        if (u.avatar_file_id) {
          await ctx.replyWithPhoto(u.avatar_file_id, { caption: info, parse_mode: 'Markdown' });
        } else {
          await ctx.reply(info, { parse_mode: 'Markdown' });
        }
      }
      return;
    }

    if (session.flow === 'admin_ban') {
      state.clear(ctx.from.id);
      const [username, ...reasonParts] = text.split(' ');
      const target = await db.getUserByUsername(username);
      if (!target) return ctx.reply('User not found.');
      await db.banUser(target.id, reasonParts.join(' '));
      try {
        await bot.telegram.sendMessage(target.telegram_id, '🚫 You have been banned from this bot.');
      } catch (e) {}
      return ctx.reply(`✅ Banned *${username}*.`, { parse_mode: 'Markdown' });
    }

    if (session.flow === 'admin_unban') {
      state.clear(ctx.from.id);
      const target = await db.getUserByUsername(text);
      if (!target) return ctx.reply('User not found.');
      await db.unbanUser(target.id);
      return ctx.reply(`✅ Unbanned *${text}*.`, { parse_mode: 'Markdown' });
    }

    if (session.flow === 'admin_broadcast') {
      state.clear(ctx.from.id);
      const ids = await db.getAllTelegramIds();
      let sent = 0;
      let failed = 0;
      await ctx.reply(`📢 Broadcasting to ${ids.length} users...`);
      for (const id of ids) {
        try {
          await bot.telegram.sendMessage(id, `📢 *Announcement*\n\n${text}`, { parse_mode: 'Markdown' });
          sent++;
        } catch (e) {
          failed++;
        }
        await new Promise((r) => setTimeout(r, 40)); // gentle rate-limit (~25 msg/sec cap)
      }
      return ctx.reply(`✅ Broadcast complete. Sent: ${sent}, Failed: ${failed}`);
    }

    return next();
  });
}

module.exports = { register };

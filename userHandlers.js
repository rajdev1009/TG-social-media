// userHandlers.js — everything a normal (non-admin) user interacts with.

const db = require('./db');
const state = require('./state');
const { mainMenu, profileInlineKeyboard, cancelInline } = require('./keyboards');
const { isValidUsername, profileCaption, notifyAdmin, realIdTag } = require('./helpers');
const { isSuspicious } = require('./moderation');

function register(bot, { adminId, privateChannelId }) {
  // ---------------- /start & registration wizard ----------------

  bot.start(async (ctx) => {
    const tgUser = ctx.from;
    let user = await db.getUserByTelegramId(tgUser.id);

    if (!user) {
      user = await db.createUser(tgUser.id, tgUser.username, tgUser.first_name);
      await notifyAdmin(
        bot,
        adminId,
        `🆕 *New user joined*\n${realIdTag(user)}`
      );
    }

    if (user.is_banned) {
      return ctx.reply('🚫 You are banned from using this bot.');
    }

    if (user.reg_step === 'ask_username') {
      state.set(tgUser.id, { flow: 'set_username' });
      return ctx.reply(
        '👋 Welcome! Let\'s set up your profile.\n\nPick a *public username* (3-20 chars, letters/numbers/underscore, must start with a letter). This is what other users will see — your real Telegram identity always stays private.',
        { parse_mode: 'Markdown' }
      );
    }

    if (user.reg_step === 'ask_avatar') {
      state.set(tgUser.id, { flow: 'set_avatar' });
      return ctx.reply('📸 Now send a profile photo (1-5MB). You can send /skip to use a default avatar.');
    }

    return ctx.reply(`Welcome back, *${user.username}*! 👋`, {
      parse_mode: 'Markdown',
      ...mainMenu(user.is_admin || tgUser.id === adminId),
    });
  });

  // ---------------- text router (handles wizard steps + main menu + DM composing) ----------------

  bot.on('text', async (ctx, next) => {
    const tgId = ctx.from.id;
    const text = ctx.message.text.trim();
    const session = state.get(tgId);
    const user = await db.getUserByTelegramId(tgId);

    if (user && user.is_banned) return ctx.reply('🚫 You are banned from using this bot.');
    if (user) await db.touchLastActive(user.id);

    // ---- registration: username step ----
    if (session?.flow === 'set_username') {
      if (!isValidUsername(text)) {
        return ctx.reply('❌ Invalid format. Use 3-20 letters/numbers/underscore, starting with a letter. Try again:');
      }
      const taken = await db.getUserByUsername(text);
      if (taken) return ctx.reply('❌ That username is already taken. Try another:');

      await db.setUsername(user.id, text);
      state.set(tgId, { flow: 'set_avatar' });
      return ctx.reply(`✅ Username set to *${text}*!\n\n📸 Now send a profile photo (1-5MB), or /skip for a default avatar.`, {
        parse_mode: 'Markdown',
      });
    }

    // ---- registration: avatar step (text-only branch handles /skip) ----
    if (session?.flow === 'set_avatar' && text === '/skip') {
      await db.setAvatar(user.id, null, null);
      state.clear(tgId);
      return ctx.reply('✅ Profile complete! Welcome aboard 🎉', mainMenu(user.is_admin || tgId === adminId));
    }

    // ---- DM composer ----
    if (session?.flow === 'sending_dm' && session.targetId) {
      const target = await db.getUserById(session.targetId);
      state.clear(tgId);

      if (!target) return ctx.reply('That user no longer exists.', mainMenu(user.is_admin));

      if (isSuspicious(text)) {
        await notifyAdmin(bot, adminId, `⚠️ *Suspicious DM blocked*\nFrom: ${realIdTag(user)}\nTo: ${realIdTag(target)}\nContent: ${text.slice(0, 200)}`);
        return ctx.reply('⚠️ Your message looks like spam and was not delivered.', mainMenu(user.is_admin));
      }

      await db.saveMessage(user.id, target.id, text);
      try {
        await bot.telegram.sendMessage(
          target.telegram_id,
          `💬 New message from *${user.username}*:\n\n${text}\n\n_Reply via the bot: search this user and tap Message._`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        // user may have blocked the bot
      }

      // Real-ID mapping goes only to admin, never to the recipient.
      await notifyAdmin(
        bot,
        adminId,
        `✉️ *DM sent*\nFrom: ${realIdTag(user)} (@${user.username})\nTo: ${realIdTag(target)} (@${target.username})\nContent: ${text.slice(0, 300)}`
      );

      return ctx.reply('✅ Message sent!', mainMenu(user.is_admin));
    }

    // ---- bio editor ----
    if (session?.flow === 'edit_bio') {
      state.clear(tgId);
      await db.setBio(user.id, text.slice(0, 200));
      return ctx.reply('✅ Bio updated!', mainMenu(user.is_admin));
    }

    // ---- main menu buttons ----
    if (!user || user.reg_step !== 'done') return next(); // let /start handle unfinished registration

    switch (text) {
      case '🔀 Explore':
        return sendExploreProfile(ctx, user.id);
      case '👤 My Profile':
        return sendOwnProfile(ctx, user);
      case '✉️ Messages':
        return ctx.reply('📥 To message someone, open their profile via 🔀 Explore and tap 💬 Message.');
      case '⚙️ Settings':
        return ctx.reply('⚙️ Settings:\n/setusername — change username\n/setbio — change bio\n/setavatar — change avatar');
      case '🛠 Admin Panel':
        return next(); // adminHandlers will pick this up
      default:
        return next();
    }
  });

  bot.command('setbio', async (ctx) => {
    state.set(ctx.from.id, { flow: 'edit_bio' });
    return ctx.reply('✍️ Send your new bio (max 200 chars):');
  });

  bot.command('setusername', async (ctx) => {
    state.set(ctx.from.id, { flow: 'set_username' });
    return ctx.reply('✍️ Send a new username:');
  });

  bot.command('setavatar', async (ctx) => {
    state.set(ctx.from.id, { flow: 'set_avatar' });
    return ctx.reply('📸 Send a new profile photo:');
  });

  // ---------------- photo upload -> forward to private channel ----------------

  bot.on('photo', async (ctx) => {
    const tgId = ctx.from.id;
    const session = state.get(tgId);
    if (session?.flow !== 'set_avatar') return; // ignore stray photos

    const user = await db.getUserByTelegramId(tgId);
    if (!user) return;

    const photo = ctx.message.photo[ctx.message.photo.length - 1]; // highest resolution
    const fileId = photo.file_id;

    let channelMsgId = null;
    try {
      // CRITICAL OPTIMIZATION: forward the photo to the private channel.
      // We keep only file_id (+ this message id as backup) in the DB —
      // the actual image bytes never touch our database.
      const forwarded = await bot.telegram.sendPhoto(privateChannelId, fileId, {
        caption: `Avatar — user_id:${user.id} — @${user.telegram_username || 'n/a'} — ${user.telegram_id}`,
      });
      channelMsgId = forwarded.message_id;
    } catch (e) {
      console.error('Failed to archive avatar to private channel:', e.message);
    }

    await db.setAvatar(user.id, fileId, channelMsgId);
    state.clear(tgId);

    return ctx.reply('✅ Profile complete! Welcome aboard 🎉', mainMenu(user.is_admin));
  });

  // ---------------- inline callback actions ----------------

  bot.action(/^like:(\d+)$/, (ctx) => handleReaction(ctx, 'like'));
  bot.action(/^dislike:(\d+)$/, (ctx) => handleReaction(ctx, 'dislike'));

  async function handleReaction(ctx, type) {
    const targetId = Number(ctx.match[1]);
    const actor = await db.getUserByTelegramId(ctx.from.id);
    if (!actor) return ctx.answerCbQuery('Please /start first.');
    if (actor.id === targetId) return ctx.answerCbQuery("You can't react to your own profile 🙂");

    const result = await db.toggleReaction(actor.id, targetId, type);
    const target = await db.getUserById(targetId);
    await ctx.answerCbQuery(result === 'removed' ? 'Removed' : type === 'like' ? '❤️ Liked!' : '👎 Disliked');
    await refreshProfileMessage(ctx, actor, target);
  }

  bot.action(/^follow:(\d+)$/, async (ctx) => {
    const targetId = Number(ctx.match[1]);
    const actor = await db.getUserByTelegramId(ctx.from.id);
    if (!actor) return ctx.answerCbQuery('Please /start first.');
    if (actor.id === targetId) return ctx.answerCbQuery("You can't follow yourself 🙂");

    const result = await db.toggleFollow(actor.id, targetId);
    const target = await db.getUserById(targetId);

    if (result === 'followed') {
      try {
        await bot.telegram.sendMessage(target.telegram_id, `➕ *${actor.username}* started following you!`, { parse_mode: 'Markdown' });
      } catch (e) {}
    }

    await ctx.answerCbQuery(result === 'followed' ? '✅ Following' : 'Unfollowed');
    await refreshProfileMessage(ctx, actor, target);
  });

  bot.action(/^msg:(\d+)$/, async (ctx) => {
    const targetId = Number(ctx.match[1]);
    const actor = await db.getUserByTelegramId(ctx.from.id);
    if (!actor) return ctx.answerCbQuery('Please /start first.');
    if (actor.id === targetId) return ctx.answerCbQuery("You can't message yourself 🙂");

    state.set(ctx.from.id, { flow: 'sending_dm', targetId });
    await ctx.answerCbQuery();
    return ctx.reply('✍️ Type your message — it will be delivered anonymously (your public username shown, real identity protected):', cancelInline());
  });

  bot.action(/^report:(\d+)$/, async (ctx) => {
    const targetId = Number(ctx.match[1]);
    const actor = await db.getUserByTelegramId(ctx.from.id);
    const target = await db.getUserById(targetId);
    if (!actor || !target) return ctx.answerCbQuery('Error');

    await db.createReport(actor.id, targetId, 'Reported via profile button');
    await notifyAdmin(bot, adminId, `🚩 *Report filed*\nReporter: ${realIdTag(actor)} (@${actor.username})\nReported: ${realIdTag(target)} (@${target.username})`);
    return ctx.answerCbQuery('🚩 Reported to admin. Thank you.');
  });

  bot.action(/^explore_next:(\d+)$/, async (ctx) => {
    const actor = await db.getUserByTelegramId(ctx.from.id);
    if (!actor) return ctx.answerCbQuery('Please /start first.');
    await ctx.answerCbQuery();
    return sendExploreProfile(ctx, actor.id, true);
  });

  bot.action('cancel_flow', async (ctx) => {
    state.clear(ctx.from.id);
    await ctx.answerCbQuery('Cancelled');
    return ctx.reply('Cancelled.');
  });

  bot.action('edit_bio', async (ctx) => {
    state.set(ctx.from.id, { flow: 'edit_bio' });
    await ctx.answerCbQuery();
    return ctx.reply('✍️ Send your new bio (max 200 chars):');
  });

  bot.action('edit_avatar', async (ctx) => {
    state.set(ctx.from.id, { flow: 'set_avatar' });
    await ctx.answerCbQuery();
    return ctx.reply('📸 Send a new profile photo:');
  });

  // ---------------- shared render helpers ----------------

  async function sendExploreProfile(ctx, actorId, edit = false) {
    const target = await db.getRandomProfile(actorId);
    if (!target) return ctx.reply('No other profiles to explore yet. Check back soon!');

    const [liked, following] = await Promise.all([
      db.getUserReaction(actorId, target.id),
      db.isFollowing(actorId, target.id),
    ]);

    const opts = {
      liked: liked === 'like',
      disliked: liked === 'dislike',
      following,
      likeCount: target.like_count,
      dislikeCount: target.dislike_count,
      isSelf: false,
    };

    const caption = profileCaption(target);
    const kb = profileInlineKeyboard(target.id, opts);

    if (target.avatar_file_id) {
      return ctx.replyWithPhoto(target.avatar_file_id, { caption, parse_mode: 'Markdown', ...kb });
    }
    return ctx.reply(caption, { parse_mode: 'Markdown', ...kb });
  }

  async function sendOwnProfile(ctx, user) {
    const caption = profileCaption(user, { isSelf: true });
    const kb = profileInlineKeyboard(user.id, { isSelf: true });
    if (user.avatar_file_id) {
      return ctx.replyWithPhoto(user.avatar_file_id, { caption, parse_mode: 'Markdown', ...kb });
    }
    return ctx.reply(caption, { parse_mode: 'Markdown', ...kb });
  }

  async function refreshProfileMessage(ctx, actor, target) {
    const [liked, following] = await Promise.all([
      db.getUserReaction(actor.id, target.id),
      db.isFollowing(actor.id, target.id),
    ]);
    const opts = {
      liked: liked === 'like',
      disliked: liked === 'dislike',
      following,
      likeCount: target.like_count,
      dislikeCount: target.dislike_count,
      isSelf: false,
    };
    try {
      await ctx.editMessageReplyMarkup(profileInlineKeyboard(target.id, opts).reply_markup);
    } catch (e) {
      // message might be too old to edit — ignore
    }
  }
}

module.exports = { register };

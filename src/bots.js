'use strict';
// Registry of every Telegram bot this deployment serves.
//
// Two bots can share one deployment: each registers its own webhook URL
// (…/api/telegram?bot=<botId>) and each keeps its own subscriber list, so a
// digest is only ever sent through the bot a chat actually started. Sending to a
// chat through the wrong bot fails with "bot can't initiate conversation".
//
// Env (any of these; all are optional except the first):
//   TELEGRAM_BOT_TOKEN      primary bot
//   TELEGRAM_BOT_TOKEN_2    second bot (…_3, …_4 also work)
//   TELEGRAM_BOTS           comma-separated tokens, an alternative to the above
//
// A bot token looks like "123456789:AA…". The digits before the colon are the
// bot's own account id, so we use them as a stable botId without an API call.
const config = require('./config');

const MAX_NUMBERED_TOKENS = 9;

function botIdFromToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return '';
  const [id] = raw.split(':');
  return /^\d+$/.test(id) ? id : raw.slice(0, 12);
}

function collectTokens() {
  const tokens = [];

  const push = (value) => {
    const token = String(value || '').trim();
    if (token && !tokens.includes(token)) tokens.push(token);
  };

  push(config.telegram.botToken);
  for (let i = 2; i <= MAX_NUMBERED_TOKENS; i += 1) {
    push(process.env[`TELEGRAM_BOT_TOKEN_${i}`]);
  }
  for (const token of String(process.env.TELEGRAM_BOTS || '').split(',')) {
    push(token);
  }

  return tokens;
}

// [{ botId, token, isPrimary }] — the primary bot is TELEGRAM_BOT_TOKEN.
function listBots() {
  return collectTokens().map((token, index) => ({
    botId: botIdFromToken(token),
    token,
    isPrimary: index === 0,
  }));
}

function primaryBot() {
  return listBots()[0] || null;
}

// Resolves the bot a webhook request is for. Falls back to the primary bot so a
// single-bot setup keeps working without a ?bot= parameter.
function resolveBot(botId) {
  const bots = listBots();
  if (!bots.length) return null;

  const wanted = String(botId || '').trim();
  if (!wanted) return bots[0];

  return bots.find((bot) => bot.botId === wanted) || null;
}

function isMultiBot() {
  return listBots().length > 1;
}

module.exports = {
  botIdFromToken,
  listBots,
  primaryBot,
  resolveBot,
  isMultiBot,
};

"use strict";
const config = require("./config");
const {
  readSubscribers,
  upsertSubscriber,
  removeSubscriber,
} = require("./subscribers");
const { listBots, primaryBot } = require("./bots");

// ─── WhatsApp via CallMeBot ───────────────────────────────────────────────────

async function sendWhatsApp(message) {
  const { phone, apiKey } = config.whatsapp;
  if (!phone || !apiKey) return false;

  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(message)}&apikey=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      console.log("  WhatsApp notification sent");
      return true;
    }
    console.warn(`  WhatsApp failed: ${res.status}`);
    return false;
  } catch (e) {
    console.warn(`  WhatsApp error: ${e.message}`);
    return false;
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

function normalizeChatId(chatId) {
  return String(chatId || "").trim();
}

function adminChatId() {
  return normalizeChatId(config.telegram.chatId);
}

function isAdminChat(chatId) {
  const admin = adminChatId();
  return Boolean(admin && normalizeChatId(chatId) === admin);
}

async function isSubscriber(chatId, botId) {
  const normalized = normalizeChatId(chatId);
  if (!normalized) return false;
  if (isAdminChat(normalized)) return true;
  const subscribers = await readSubscribers(botId).catch(() => []);
  return subscribers.some(
    (item) => normalizeChatId(item.chatId) === normalized,
  );
}

function normalizeCommand(text) {
  const normalized = String(text || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "";
  const first = normalized.split(/\s+/)[0];
  return first.replace(/^\/+/, "").split("@")[0];
}

function parseScanMode(text) {
  const parts = String(text || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .slice(1);
  const mode = parts[0] || "default";
  if (mode === "all" || mode === "everything") return "all";
  if (
    mode === "goodfirst" ||
    mode === "good-first" ||
    mode === "good_first" ||
    mode === "good"
  )
    return "goodfirst";
  if (mode === "medium" || mode === "med") return "medium";
  return "default";
}

function scanModeLabel(mode) {
  if (mode === "all") return "all open issues";
  if (mode === "goodfirst") return "good first issues";
  if (mode === "medium") return "medium-effort issues";
  return "top prioritized issues";
}

// botId scopes the list to one bot's audience. options.includeAdmin adds the
// TELEGRAM_CHAT_ID owner chat — only do that for the bot the owner actually
// started, otherwise Telegram rejects the send.
async function listTelegramSubscribers(botId, options = {}) {
  const { includeAdmin = true } = options;
  const subscribers = await readSubscribers(botId).catch(() => []);
  const ids = subscribers
    .map((item) => normalizeChatId(item.chatId))
    .filter(Boolean);
  const admin = includeAdmin ? adminChatId() : "";
  return [...new Set([admin, ...ids].filter(Boolean))];
}

async function subscribeTelegramChat(chat, botId) {
  const chatId = normalizeChatId(chat && chat.id);
  if (!chatId) throw new Error("Cannot subscribe Telegram chat without an id");

  return upsertSubscriber({
    chatId,
    botId: botId || "",
    type: chat.type || "",
    title: chat.title || "",
    username: chat.username || "",
    firstName: chat.first_name || "",
    lastName: chat.last_name || "",
  });
}

async function unsubscribeTelegramChat(chatId, botId) {
  return removeSubscriber(chatId, botId);
}

async function sendTelegramToChat(chatId, message, botToken) {
  const token = botToken || config.telegram.botToken;
  if (!token || !chatId) return false;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      console.log("  Telegram notification sent");
      return true;
    }
    const err = await res.json();
    console.warn(`  Telegram failed: ${err.description}`);
    return false;
  } catch (e) {
    console.warn(`  Telegram error: ${e.message}`);
    return false;
  }
}

// Sends to every configured bot's own audience, each through its own token.
async function sendTelegram(message) {
  const bots = listBots();
  if (!bots.length) return false;

  let sentAny = false;
  for (const bot of bots) {
    const chatIds = await listTelegramSubscribers(bot.botId, {
      includeAdmin: bot.isPrimary,
    });
    if (!chatIds.length) continue;

    const results = await Promise.all(
      chatIds.map((chatId) => sendTelegramToChat(chatId, message, bot.token)),
    );
    sentAny = sentAny || results.some(Boolean);
  }
  return sentAny;
}

async function setTelegramCommands(botToken) {
  const token = botToken || config.telegram.botToken;
  if (!token) return false;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/setMyCommands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commands: [
            { command: "start", description: "Subscribe to daily updates" },
            { command: "stop", description: "Unsubscribe from daily updates" },
            {
              command: "status",
              description: "Check whether the bot is running",
            },
            { command: "help", description: "Show available commands" },
            {
              command: "scan",
              description: "Run scan: /scan all, /scan goodfirst, /scan medium",
            },
          ],
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    return res.ok;
  } catch (e) {
    console.warn(`  Telegram command menu skipped: ${e.message}`);
    return false;
  }
}

// ─── Unified send (Telegram first, WhatsApp as fallback) ─────────────────────

async function sendNotification(message) {
  const messages = Array.isArray(message) ? message : [message];
  let sentAny = false;

  for (const item of messages) {
    const sent = await sendTelegram(item);
    sentAny = sentAny || sent;
    if (!sent) {
      await sendWhatsApp(item);
    }
  }

  return sentAny;
}

// ─── Message formatter ────────────────────────────────────────────────────────

const TELEGRAM_MESSAGE_LIMIT = 3900;

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value, limit) {
  const text = cleanText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function effortLabel(value) {
  const effort = cleanText(value || "medium").toLowerCase();
  if (effort === "low") return "LOW";
  if (effort === "high") return "HIGH";
  return "MED";
}

function formatOpportunity(item, index) {
  const lines = [
    `${index + 1}. [${effortLabel(item.effort)}] ${truncate(item.opportunity, 90)}`,
    `Repo: ${cleanText(item.repo) || "Unknown repo"}`,
  ];

  if (item.issue_url) {
    lines.push(`Issue: ${cleanText(item.issue_url)}`);
  }

  if (item.why_it_qualifies) {
    lines.push(`Why: ${truncate(item.why_it_qualifies, 180)}`);
  }

  if (item.suggested_action) {
    lines.push(`Next: ${truncate(item.suggested_action, 220)}`);
  }

  if (item.clarity_tip) {
    lines.push(`Check: ${truncate(item.clarity_tip, 100)}`);
  }

  return lines.join("\n");
}

function fitMessage(message, footer) {
  if (message.length <= TELEGRAM_MESSAGE_LIMIT) return message;

  const allowed = TELEGRAM_MESSAGE_LIMIT - footer.length - 2;
  return `${message.slice(0, Math.max(0, allowed)).trim()}\n\n${footer}`;
}

function buildDigestMessage(digest) {
  const opportunities = Array.isArray(digest.contest_digest)
    ? digest.contest_digest
    : [];
  const count = opportunities.length;
  const shown = opportunities.slice(0, 8);

  const items = shown.length
    ? shown.map(formatOpportunity).join("\n\n")
    : "No implementation opportunities were returned in this scan.";

  const news = Array.isArray(digest.tech_news_summary)
    ? digest.tech_news_summary
        .slice(0, 4)
        .map((n) => `- ${truncate(n, 180)}`)
        .join("\n")
    : truncate(digest.tech_news_summary || "", 500);

  const hiddenCount = count - shown.length;
  const hiddenLine =
    hiddenCount > 0
      ? `\n\nShowing top ${shown.length}. ${hiddenCount} more are saved in the dashboard.`
      : "";

  const footer =
    "Open the dashboard for full code skeletons, issue context, and team notes.";
  const message = `Repository Intelligence Digest
Date: ${cleanText(digest.date) || new Date().toISOString().slice(0, 10)}
Opportunities found: ${count}

Top opportunities
${items}${hiddenLine}

Execution plan
${truncate(digest.quick_plan, 500)}

Signal summary
${news || "- No news summary returned."}

${footer}`;

  return fitMessage(
    message,
    "Message shortened. Open the dashboard for the full digest.",
  );
}

function buildOpportunityMessage(item, index, total) {
  const footer = "Open the dashboard for the code skeleton and work log.";
  const message = `Opportunity ${index + 1} of ${total}
[${effortLabel(item.effort)}] ${truncate(item.opportunity, 120)}

Repo: ${cleanText(item.repo) || "Unknown repo"}
Issue: ${cleanText(item.issue_url) || "No issue URL"}
Source: ${cleanText(item.source) || "scan"}
Score: ${Number(item.score || 0) || "n/a"}

Why
${truncate(item.why_it_qualifies, 450)}

Next
${truncate(item.suggested_action, 550)}

Check
${truncate(item.clarity_tip, 180) || "Run the relevant repository checks before opening a PR."}

${footer}`;

  return fitMessage(
    message,
    "Opportunity shortened. Open the dashboard for the full detail.",
  );
}

function buildDigestMessages(digest) {
  const detailLimit = Number(process.env.DIGEST_DETAIL_LIMIT || 8);
  const opportunities = Array.isArray(digest.contest_digest)
    ? digest.contest_digest.slice(
        0,
        Number.isFinite(detailLimit) && detailLimit > 0 ? detailLimit : 8,
      )
    : [];
  return [
    buildDigestMessage(digest),
    ...opportunities.map((item, index) =>
      buildOpportunityMessage(item, index, opportunities.length),
    ),
  ];
}
// ─── Telegram command listener (long-polling) ────────────────────────────────
// Calls getUpdates in a loop. When it sees /scan from the authorized chatId,
// calls onScan(). Safe to run alongside the cron scheduler.

// Processes a single Telegram update (one message). Shared by the long-polling
// listener (listenForCommands) and the serverless webhook (api/telegram.js) so
// both modes behave identically. onScan is invoked for /scan commands.
// `bot` identifies which bot received the message ({ botId, token }), so replies
// go back out through that same bot and its subscribers stay separate. Defaults
// to the primary bot for single-bot setups.
async function handleTelegramUpdate(update, onScan, bot) {
  const msg = update && update.message;
  if (!msg || !msg.chat) return;

  const active = bot || primaryBot() || {};
  const botId = active.botId || "";
  const token = active.token || config.telegram.botToken;

  const command = normalizeCommand(msg.text);
  const chatId = normalizeChatId(msg.chat.id);
  const reply = (text) => sendTelegramToChat(chatId, text, token);

  if (command === "start" || command === "subscribe") {
    await subscribeTelegramChat(msg.chat, botId);
    await reply(
      "You are subscribed. You will receive the daily Repository Intelligence Digest here. Send /stop to unsubscribe.\n\nScan commands:\n/scan - top prioritized issues\n/scan goodfirst - good first issues\n/scan medium - medium-effort issues",
    );
  } else if (command === "stop" || command === "unsubscribe") {
    await unsubscribeTelegramChat(chatId, botId);
    await reply("You are unsubscribed. Send /start any time to subscribe again.");
  } else if (command === "scan") {
    if (!(await isSubscriber(chatId, botId))) {
      await reply(
        "You need to be subscribed to trigger scans. Send /start to subscribe first.",
      );
      return;
    }
    const scanMode = parseScanMode(msg.text);
    await reply(`Got it — starting ${scanModeLabel(scanMode)} scan now...`);
    try {
      // chatId lets serverless callers report back to the requester; runScan
      // ignores the extra keys, so long-polling mode is unaffected.
      const result = await onScan({
        trigger: `telegram-${scanMode}`,
        scanMode,
        dedupe: false,
        chatId,
        botId,
      });
      // Serverless callers hand the scan off elsewhere and return a status note.
      if (result && result.message) {
        await reply(result.message);
      }
    } catch (e) {
      await reply(`Scan failed: ${e.message}`);
    }
  } else if (command === "status") {
    await reply(
      (await isSubscriber(chatId, botId))
        ? "Bot is running. Send /scan to trigger a scan, or /stop to unsubscribe from digests."
        : "Bot is running. You will receive daily updates if subscribed. Send /start to subscribe or /stop to unsubscribe.",
    );
  } else if (command === "help") {
    await reply(
      (await isSubscriber(chatId, botId))
        ? "Commands:\n/start - subscribe to daily updates\n/stop - unsubscribe\n/status - check bot\n/scan - top prioritized issues\n/scan all - broad open-issue scan\n/scan goodfirst - good first issues\n/scan medium - medium-effort issues"
        : "Commands:\n/start - subscribe to daily updates\n/stop - unsubscribe\n/status - check bot",
    );
  }
}

async function listenForCommands(onScan) {
  const { botToken } = config.telegram;
  if (!botToken) {
    console.warn("Telegram bot not configured — command listener disabled");
    return;
  }

  const bots = listBots();
  const admin = adminChatId();
  console.log(
    admin
      ? `Telegram bot listening publicly (${bots.length} bot${bots.length === 1 ? "" : "s"}). Admin scan chat: ${admin}`
      : `Telegram bot listening publicly (${bots.length} bot${bots.length === 1 ? "" : "s"}). Set TELEGRAM_CHAT_ID to enable admin /scan.`,
  );

  // Each bot has its own update stream and its own getUpdates offset, so poll
  // them in parallel rather than sequentially.
  await Promise.all(bots.map((bot) => pollBot(bot, onScan, admin)));
}

async function pollBot(bot, onScan, admin) {
  let offset = 0;
  await setTelegramCommands(bot.token);
  if (admin && bot.isPrimary) {
    await sendTelegramToChat(
      admin,
      "Bot started. Public users can send /start to subscribe. Admin can send /scan.",
      bot.token,
    );
  }

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${bot.token}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message"]`;
      const res = await fetch(url, { signal: AbortSignal.timeout(40_000) });
      if (!res.ok) {
        // 409 means a webhook is registered for this bot; polling can't also run.
        if (res.status === 409) {
          console.warn(
            `  Bot ${bot.botId}: getUpdates conflict (409) — a webhook is set. Run scripts/set-webhook.js --delete to poll instead.`,
          );
          await sleep(30_000);
        } else {
          await sleep(5000);
        }
        continue;
      }

      const { result } = await res.json();
      for (const update of result) {
        offset = update.update_id + 1;
        try {
          await handleTelegramUpdate(update, onScan, bot);
        } catch (e) {
          console.warn("Update handler error:", e.message);
        }
      }
    } catch (e) {
      if (e.name !== "TimeoutError") console.warn("Poll error:", e.message);
      await sleep(3000);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  sendNotification,
  buildDigestMessage,
  buildDigestMessages,
  listenForCommands,
  handleTelegramUpdate,
  listTelegramSubscribers,
  subscribeTelegramChat,
  unsubscribeTelegramChat,
  sendTelegramToChat,
  setTelegramCommands,
  normalizeCommand,
  parseScanMode,
};

'use strict';
const config = require('./config');

// ─── WhatsApp via CallMeBot ───────────────────────────────────────────────────

async function sendWhatsApp(message) {
  const { phone, apiKey } = config.whatsapp;
  if (!phone || !apiKey) return false;

  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(message)}&apikey=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      console.log('  WhatsApp notification sent');
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

async function sendTelegram(message) {
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) return false;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      console.log('  Telegram notification sent');
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

// ─── Unified send (WhatsApp first, Telegram as fallback) ─────────────────────

async function sendNotification(message) {
  const sent = await sendWhatsApp(message);
  if (!sent) {
    await sendTelegram(message);
  }
}

// ─── Message formatter ────────────────────────────────────────────────────────

function buildDigestMessage(digest) {
  const count = digest.contest_digest.length;

  const items = digest.contest_digest
    .map((item, i) => `${i + 1}. [${(item.effort || 'med').toUpperCase()}] ${item.opportunity}\n   → ${item.repo}`)
    .join('\n');

  const news = Array.isArray(digest.tech_news_summary)
    ? digest.tech_news_summary.slice(0, 3).map(n => `• ${n}`).join('\n')
    : digest.tech_news_summary || '';

  return `*Stacks Dev Assistant* 🔥 ${digest.date}

Found *${count} PR opportunities*:

${items}

📌 *Plan:* ${digest.quick_plan}

📰 *This week in Stacks:*
${news}

Open Airtable for code skeletons + full details!`;
}

module.exports = { sendNotification, buildDigestMessage };

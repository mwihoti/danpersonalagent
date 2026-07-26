'use strict';
// Register (or remove) the Telegram webhook so incoming messages are delivered
// to /api/telegram instead of being long-polled.
//
//   node scripts/set-webhook.js                       → register using PUBLIC_BASE_URL
//   node scripts/set-webhook.js https://app.vercel.app → register using an explicit URL
//   node scripts/set-webhook.js --delete              → remove the webhook (back to polling)
//   node scripts/set-webhook.js --info                → show current webhook status
const config = require('../src/config');
const { setTelegramCommands } = require('../src/whatsapp');

const botToken = config.telegram.botToken;

function api(method, body) {
  return fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((res) => res.json());
}

async function main() {
  if (!botToken) {
    console.error('TELEGRAM_BOT_TOKEN is not set.');
    process.exit(1);
  }

  const arg = process.argv[2];

  if (arg === '--info') {
    console.log(JSON.stringify(await api('getWebhookInfo'), null, 2));
    return;
  }

  if (arg === '--delete') {
    const result = await api('deleteWebhook', { drop_pending_updates: false });
    console.log(result.ok ? 'Webhook removed. You can use long-polling (node agent.js --bot).' : result);
    return;
  }

  const baseUrl = (arg || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl) {
    console.error('Provide the deployment URL as an argument or set PUBLIC_BASE_URL.');
    console.error('  node scripts/set-webhook.js https://your-app.vercel.app');
    process.exit(1);
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('Warning: TELEGRAM_WEBHOOK_SECRET is not set — the endpoint will accept unsigned requests.');
  }

  const webhookUrl = `${baseUrl}/api/telegram`;
  const result = await api('setWebhook', {
    url: webhookUrl,
    secret_token: secret || undefined,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });

  if (!result.ok) {
    console.error('Failed to set webhook:', result);
    process.exit(1);
  }

  await setTelegramCommands();
  console.log(`Webhook set to ${webhookUrl}`);
  console.log('Command menu registered. Send /start to the bot to test.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

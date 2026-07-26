'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(payload) {
      this.body = payload;
    },
  };
}

async function withHandler(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'danagent-webhook-'));
  const prevDataDir = process.env.DAN_AGENT_DATA_DIR;
  const prevSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const prevFetch = global.fetch;

  process.env.DAN_AGENT_DATA_DIR = dir;
  process.env.TELEGRAM_WEBHOOK_SECRET = 'topsecret';
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  for (const mod of ['../src/config', '../src/subscribers', '../src/whatsapp', '../api/telegram']) {
    delete require.cache[require.resolve(mod)];
  }
  const handler = require('../api/telegram');

  try {
    await fn(handler, calls);
  } finally {
    global.fetch = prevFetch;
    if (prevDataDir === undefined) delete process.env.DAN_AGENT_DATA_DIR;
    else process.env.DAN_AGENT_DATA_DIR = prevDataDir;
    if (prevSecret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
    else process.env.TELEGRAM_WEBHOOK_SECRET = prevSecret;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('webhook rejects requests with a wrong secret token', async () => {
  await withHandler(async (handler) => {
    const req = {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
      body: { message: { chat: { id: 1, type: 'private' }, text: '/status' } },
    };
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
  });
});

test('webhook accepts a valid update and always answers 200', async () => {
  await withHandler(async (handler, calls) => {
    const req = {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'topsecret' },
      body: { message: { chat: { id: 42, type: 'private' }, text: '/status' } },
    };
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
  });
});

test('webhook rejects non-POST methods', async () => {
  await withHandler(async (handler) => {
    const res = mockRes();
    await handler({ method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 405);
  });
});

test('/scan is handed to GitHub Actions instead of running in the request', async () => {
  const prevRepo = process.env.GITHUB_DISPATCH_REPO;
  const prevToken = process.env.GITHUB_DISPATCH_TOKEN;
  const prevChatId = process.env.TELEGRAM_CHAT_ID;
  process.env.GITHUB_DISPATCH_REPO = 'someone/danagent';
  process.env.GITHUB_DISPATCH_TOKEN = 'ghp_test';
  // Admin chat, so the subscriber check passes without hitting Airtable. Must be
  // set before withHandler() re-requires config, which caches it at load time.
  process.env.TELEGRAM_CHAT_ID = '42';

  try {
    await withHandler(async (handler, calls) => {
      const req = {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'topsecret' },
        body: {
          message: {
            chat: { id: 42, type: 'private' },
            text: '/scan goodfirst',
          },
        },
      };
      const res = mockRes();
      await handler(req, res);

      assert.equal(res.statusCode, 200);

      const dispatch = calls.find((c) =>
        c.url.includes('/repos/someone/danagent/dispatches'),
      );
      assert.ok(dispatch, 'expected a repository_dispatch call');

      const payload = JSON.parse(dispatch.opts.body);
      assert.equal(payload.event_type, 'telegram-scan');
      assert.equal(payload.client_payload.scan_mode, 'goodfirst');
      assert.equal(payload.client_payload.chat_id, '42');
    });
  } finally {
    if (prevRepo === undefined) delete process.env.GITHUB_DISPATCH_REPO;
    else process.env.GITHUB_DISPATCH_REPO = prevRepo;
    if (prevToken === undefined) delete process.env.GITHUB_DISPATCH_TOKEN;
    else process.env.GITHUB_DISPATCH_TOKEN = prevToken;
    if (prevChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = prevChatId;
  }
});

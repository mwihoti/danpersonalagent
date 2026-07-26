'use strict';
// Durable subscriber storage.
//
// Uses Airtable when AIRTABLE_API_KEY + AIRTABLE_BASE_ID are set (required for
// serverless/webhook deployments where the filesystem is ephemeral), and falls
// back to a local JSON file for local development or when Airtable is briefly
// unreachable.
//
// Airtable table: `Subscribers` (override with AIRTABLE_SUBSCRIBERS_TABLE)
//   ChatId (single line text)  ← unique key
//   Type (single line text)
//   Title (single line text)
//   Username (single line text)
//   First Name (single line text)
//   Last Name (single line text)
//   Subscribed At (single line text — ISO timestamp)
//   Last Seen At (single line text — ISO timestamp)
const config = require('./config');

// `fs`/`path` are pulled in lazily so the Airtable path stays runtime-agnostic
// (Cloudflare Workers and other edge runtimes have no filesystem). Only the
// local-development fallback touches them.
function nodeFs() {
  return require('fs/promises');
}

function localPaths() {
  const path = require('path');
  const dir =
    process.env.DAN_AGENT_DATA_DIR ||
    (process.env.VERCEL
      ? path.join('/tmp', 'danagent-data')
      : path.join(__dirname, '..', 'data'));
  return { dir, file: path.join(dir, 'telegram-subscribers.json') };
}

let localWriteQueue = Promise.resolve();

function airtableEnabled() {
  return Boolean(config.airtable.apiKey && config.airtable.baseId);
}

function isNetworkError(error) {
  const code = error && typeof error === 'object' ? error.code : '';
  const name = error && typeof error === 'object' ? error.name : '';
  return (
    name === 'TimeoutError' ||
    ['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'].includes(code)
  );
}

function normalizeChatId(chatId) {
  return String(chatId || '').trim();
}

// ─── Record <-> Airtable field mapping ───────────────────────────────────────

function toRecord(recordId, fields = {}) {
  return {
    recordId,
    chatId: normalizeChatId(fields.ChatId),
    type: fields.Type || '',
    title: fields.Title || '',
    username: fields.Username || '',
    firstName: fields['First Name'] || '',
    lastName: fields['Last Name'] || '',
    subscribedAt: fields['Subscribed At'] || '',
    lastSeenAt: fields['Last Seen At'] || '',
  };
}

function toFields(record) {
  return {
    ChatId: normalizeChatId(record.chatId),
    Type: record.type || '',
    Title: record.title || '',
    Username: record.username || '',
    'First Name': record.firstName || '',
    'Last Name': record.lastName || '',
    'Subscribed At': record.subscribedAt || '',
    'Last Seen At': record.lastSeenAt || '',
  };
}

// ─── Airtable REST helpers ────────────────────────────────────────────────────

function airtableUrl(suffix = '') {
  const table = encodeURIComponent(config.airtable.subscribersTable);
  return `https://api.airtable.com/v0/${config.airtable.baseId}/${table}${suffix}`;
}

async function airtableRequest(method, suffix, body) {
  const res = await fetch(airtableUrl(suffix), {
    method,
    headers: {
      Authorization: `Bearer ${config.airtable.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const error = new Error(`Airtable ${method} ${res.status}: ${text.slice(0, 200)}`);
    error.status = res.status;
    throw error;
  }
  if (method === 'DELETE') return res.json().catch(() => ({}));
  return res.json();
}

async function airtableReadAll() {
  const records = [];
  let offset;
  do {
    const query = new URLSearchParams({ pageSize: '100' });
    if (offset) query.set('offset', offset);
    const data = await airtableRequest('GET', `?${query.toString()}`);
    for (const row of data.records || []) {
      records.push(toRecord(row.id, row.fields));
    }
    offset = data.offset;
  } while (offset);
  return records.filter((item) => item.chatId);
}

async function airtableFind(chatId) {
  const normalized = normalizeChatId(chatId);
  const formula = `{ChatId}="${normalized.replace(/"/g, '\\"')}"`;
  const query = new URLSearchParams({
    filterByFormula: formula,
    maxRecords: '1',
  });
  const data = await airtableRequest('GET', `?${query.toString()}`);
  const row = (data.records || [])[0];
  return row ? toRecord(row.id, row.fields) : null;
}

// ─── Local file fallback ──────────────────────────────────────────────────────

async function ensureLocalStore() {
  const fs = nodeFs();
  const { dir, file } = localPaths();
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, '[]\n', 'utf8');
  }
}

async function localReadAll() {
  await ensureLocalStore();
  const raw = await nodeFs().readFile(localPaths().file, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed)
    ? parsed.map((item) => ({ ...item, chatId: normalizeChatId(item.chatId) }))
    : [];
}

async function localWriteAll(records) {
  await ensureLocalStore();
  await nodeFs().writeFile(
    localPaths().file,
    `${JSON.stringify(records, null, 2)}\n`,
    'utf8',
  );
}

function serializeLocalWrite(task) {
  const next = localWriteQueue.then(task, task);
  localWriteQueue = next.catch(() => {});
  return next;
}

async function localUpsert(record) {
  return serializeLocalWrite(async () => {
    const records = await localReadAll();
    const idx = records.findIndex(
      (item) => normalizeChatId(item.chatId) === normalizeChatId(record.chatId),
    );
    if (idx === -1) {
      records.push(record);
    } else {
      records[idx] = { ...records[idx], ...record };
    }
    await localWriteAll(records);
    return record;
  });
}

async function localRemove(chatId) {
  const normalized = normalizeChatId(chatId);
  return serializeLocalWrite(async () => {
    const records = await localReadAll();
    const next = records.filter(
      (item) => normalizeChatId(item.chatId) !== normalized,
    );
    await localWriteAll(next);
    return next.length !== records.length;
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function readSubscribers() {
  if (airtableEnabled()) {
    try {
      return await airtableReadAll();
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      console.warn(`  Subscribers: Airtable unavailable, reading local store (${error.message})`);
    }
  }
  return localReadAll();
}

async function upsertSubscriber(record) {
  const chatId = normalizeChatId(record.chatId);
  if (!chatId) throw new Error('Cannot subscribe a chat without an id');

  const now = new Date().toISOString();

  if (airtableEnabled()) {
    try {
      const existing = await airtableFind(chatId);
      const merged = {
        ...record,
        chatId,
        subscribedAt: existing?.subscribedAt || record.subscribedAt || now,
        lastSeenAt: now,
      };
      const fields = toFields(merged);
      if (existing) {
        const updated = await airtableRequest('PATCH', `/${existing.recordId}`, {
          fields,
          typecast: true,
        });
        return toRecord(updated.id, updated.fields);
      }
      const created = await airtableRequest('POST', '', {
        records: [{ fields }],
        typecast: true,
      });
      const row = created.records[0];
      return toRecord(row.id, row.fields);
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      console.warn(`  Subscribers: Airtable write failed, using local store (${error.message})`);
    }
  }

  return localUpsert({
    ...record,
    chatId,
    subscribedAt: record.subscribedAt || now,
    lastSeenAt: now,
  });
}

async function removeSubscriber(chatId) {
  const normalized = normalizeChatId(chatId);
  if (!normalized) return false;

  if (airtableEnabled()) {
    try {
      const existing = await airtableFind(normalized);
      if (!existing) return false;
      await airtableRequest('DELETE', `/${existing.recordId}`);
      return true;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      console.warn(`  Subscribers: Airtable delete failed, using local store (${error.message})`);
    }
  }

  return localRemove(normalized);
}

module.exports = {
  readSubscribers,
  upsertSubscriber,
  removeSubscriber,
  normalizeChatId,
};

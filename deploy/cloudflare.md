# Cloudflare Workers — assessment and migration plan

Short version: **you probably don't need this.** With scans running on GitHub
Actions, the thing you deploy is a thin webhook, and Vercel already serves it
well. Read the verdict below before spending a day on a port.

> Free-tier limits on both platforms change. Verify current numbers against the
> Cloudflare and Vercel docs before deciding.

---

## Why the platform matters less than it used to

The bot now has three moving parts, and only one of them is hosted:

| Part | Where it runs | Constraint |
|---|---|---|
| `/start` `/stop` `/status` `/help` | webhook (Vercel) | milliseconds |
| `/scan` (full scan) | **GitHub Actions** | 6-hour budget |
| Daily digest | **GitHub Actions** cron | 6-hour budget |

Because the heavy work and the schedule both live in GitHub Actions, the host
only ever handles small, fast requests. That erases the two reasons you'd
normally switch hosts: **function duration** and **cron flexibility**.

---

## Cloudflare vs Vercel for this workload

| | Cloudflare Workers (Free) | Vercel (Hobby) |
|---|---|---|
| Cold starts | None (V8 isolates) — consistently fast | Yes, typically a few hundred ms on first hit |
| Request budget | ~100k requests/day | Generous for a personal bot |
| Execution limit | Metered on **CPU time** (~10ms free); `fetch` wait doesn't count | Wall-clock `maxDuration` (60s configured) |
| Cron triggers | Full cron, minute granularity, on free | Hobby crons are limited (roughly once daily, imprecise) |
| Node compatibility | No real `fs`; needs `nodejs_compat`, ESM, and Web APIs | Runs this CommonJS repo as-is |
| Port effort for this repo | ~half a day | **Zero — already deployed** |

**Where Cloudflare genuinely wins:** no cold starts (a `/status` reply feels
instant every time), and real cron on the free tier.

**Where that advantage disappears here:** GitHub Actions already owns the
schedule, so Vercel's weak cron never bites. And a few hundred ms of cold start
is imperceptible in a chat app.

---

## Verdict

**Stay on Vercel.** Move to Cloudflare only if one of these becomes true:

- You want the webhook to feel instant on *every* message (no cold starts).
- You want to drop GitHub Actions and schedule scans from the host itself,
  more than once a day or at a precise time.
- You hit Vercel free-tier limits.

---

## Migration plan (if you decide to do it)

The port is realistic because the webhook's whole surface is already pure
`fetch`: verify a secret → read/write Airtable over REST → call the Telegram
API → POST a GitHub `repository_dispatch`. No filesystem, no Node-only APIs.

`src/subscribers.js` already loads `fs` lazily, so the Airtable path imports
cleanly on Workers; only the local-dev fallback touches the filesystem.

### Step 1 — Scaffold

```bash
npm create cloudflare@latest danagent-bot -- --type=hello-world
cd danagent-bot
```

### Step 2 — `wrangler.toml`

```toml
name = "danagent-bot"
main = "src/worker.js"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

# Optional: replaces the GitHub Actions cron if you want the host to schedule.
# [triggers]
# crons = ["0 5 * * *"]
```

### Step 3 — Port the handler

Workers use ESM and a `fetch` export instead of `(req, res)`. The logic in
`api/telegram.js` maps over almost line for line:

```js
export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (request.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }
    const update = await request.json();
    ctx.waitUntil(handleTelegramUpdate(update, triggerScan));  // same shape as ctx.waitUntil on Vercel
    return Response.json({ ok: true });
  },
};
```

Two adjustments to the shared code:

1. **Config**: Workers pass secrets as `env`, not `process.env`. Thread `env`
   through, or assign it to a module-level object at the top of `fetch`.
2. **Module format**: convert the handful of modules the Worker touches
   (`subscribers`, `scan-dispatch`, and the Telegram helpers) to ESM exports, or
   run them through a bundler. Leave the scan pipeline alone — it stays in
   GitHub Actions and never gets imported by the Worker.

### Step 4 — Secrets

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put AIRTABLE_API_KEY
wrangler secret put AIRTABLE_BASE_ID
wrangler secret put GITHUB_DISPATCH_TOKEN
# GITHUB_DISPATCH_REPO and AIRTABLE_TABLE_NAME can be plain [vars]
```

### Step 5 — Deploy and repoint the webhook

```bash
wrangler deploy
PUBLIC_BASE_URL=https://danagent-bot.<subdomain>.workers.dev \
TELEGRAM_WEBHOOK_SECRET=your_secret \
npm run set-webhook
```

`scripts/set-webhook.js` is host-agnostic — it just needs the new base URL.
`--info` confirms the switch; `--delete` reverts to long-polling.

### Optional — Workers KV for update dedupe

Telegram retries an update if it isn't acked. The current handler acks fast so
this is rare, but KV (free tier) makes it airtight: store each `update_id`
briefly and skip repeats.

### Rollback

Re-run `npm run set-webhook` against the Vercel URL. Nothing else changes —
subscribers live in Airtable, so no state migrates.

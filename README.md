# Repository Intelligence Dashboard

An AI-powered operations dashboard that scans GitHub repositories for high-signal implementation opportunities, generates starter code, and delivers a daily digest to your team.

---

## What It Does

Every morning at 8am Nairobi time the agent:

1. **Scans GitHub** — pulls open issues from the repositories in your dashboard watchlist, prioritising `good first issue`, `help wanted`, and `bug` labels
2. **Fetches tech news** — TechCrunch, Wired, Ars Technica, TLDR Tech, GitHub Blog, GitHub Releases, Hacker News
3. **Analyses with a configured model provider** — prefers Gemini or Groq when keys are present, and falls back to Ollama locally
4. **Saves to Airtable** — structured database of opportunities with effort level, suggested action, and starter code
5. **Notifies via Telegram** — sends a digest with top opportunities and a short plan, with WhatsApp as fallback

---

## Architecture

```
agent.js                    ← Orchestrator + cron scheduler
src/
├── github.js               ← GitHub API scanner (issues + releases)
├── gemma.js                ← Model-provider interface + digest validation
├── news.js                 ← Multi-source news aggregator (RSS + APIs)
├── airtable.js             ← Airtable record writer
├── whatsapp.js             ← Telegram (primary) + WhatsApp/CallMeBot (fallback)
└── config.js               ← Environment variable loader
scripts/
└── setup-airtable.js       ← One-time Airtable field creator
```

**Data flow:**
```
GitHub API ─┐
            ├─→ LLM provider (Gemini/Groq/Ollama) ─→ JSON digest ─→ Airtable
News/RSS  ──┘                                                └─→ Telegram
```

---

## Prerequisites

- Node.js v18+
- An [Ollama account](https://ollama.com) (for `gemma4:31b-cloud`)
- A GitHub account (for the fine-grained token)
- An Airtable account
- A Telegram bot (via @BotFather)

---

## Local Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd danagent
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your keys (see [Configuration](#configuration) below).

### 3. Set up Airtable table

Create a base in Airtable, then run:

```bash
npm run setup
```

If your network can't reach the Airtable API, create these fields manually in the Airtable UI:

| Field name | Type |
|---|---|
| Opportunity | Single line text |
| Date | Date |
| Repo | Single line text |
| Effort | Single select (`low`, `medium`, `high`) |
| Why It Qualifies | Long text |
| Suggested Action | Long text |
| Clarity Tip | Long text |
| Why It Matters | Long text |
| Quick Plan | Long text |
| Issue URL | URL |
| Code Skeleton | Long text |

<a name="subscribers-table"></a>
#### Subscribers table

For durable Telegram subscriptions (required in webhook/serverless mode), create a second table named `Subscribers` (override with `AIRTABLE_SUBSCRIBERS_TABLE`):

| Field name | Type |
|---|---|
| ChatId | Single line text |
| BotId | Single line text |
| Type | Single line text |
| Title | Single line text |
| Username | Single line text |
| First Name | Single line text |
| Last Name | Single line text |
| Subscribed At | Single line text |
| Last Seen At | Single line text |

### 4. Log in to Ollama

```bash
ollama login
```

### 5. Run a test scan

```bash
npm run scan
```

You should see the digest printed in terminal, a notification message, and new rows in Airtable.

### 6. Start the daily schedule

```bash
npm start
```

Runs at 8am Nairobi time (Africa/Nairobi) every day.

Scheduled scans use the dashboard watchlist first. If the watchlist is empty, the agent falls back to the BitcoinDevs good-first-issues page and scans the GitHub repositories linked there.

### 7. Run the public Telegram bot

```bash
node agent.js --bot
```

Bot mode runs the daily scheduler and listens for Telegram commands:

| Command | Who can use it | What it does |
|---|---|---|
| `/start` or `/subscribe` | Anyone | Subscribes that Telegram chat to daily digest notifications |
| `/stop` or `/unsubscribe` | Anyone | Unsubscribes that Telegram chat |
| `/status` | Anyone | Confirms the bot is running |
| `/help` | Anyone | Shows available commands |
| `/scan` | Admin chat only | Runs the normal top-priority scan immediately |
| `/scan all` | Admin chat only | Scans a broader set of open issues |
| `/scan goodfirst` | Admin chat only | Focuses on good-first/BitcoinDevs issues |
| `/scan medium` | Admin chat only | Focuses on medium-effort implementation issues |

Set `TELEGRAM_BOT_TOKEN` to make the bot public. Set `TELEGRAM_CHAT_ID` to your admin chat id if you want `/scan` to be available only to you.

Subscribed chats are stored in **Airtable** when `AIRTABLE_API_KEY` + `AIRTABLE_BASE_ID` are set (durable, works on serverless), and fall back to a local JSON file (`data/telegram-subscribers.json`, or `/tmp/danagent-data` on Vercel) for local development. See [Subscribers table](#subscribers-table) for the schema.

### 8. Run the bot on Vercel with webhooks (free, always responds)

Long-polling (`--bot`) needs a process running 24/7. On free serverless hosts that scale to zero (Vercel, and fly.io's auto-stop machines), that process dies and the bot goes silent. **Webhook mode** avoids this: Telegram pushes each message to `/api/telegram`, so the bot wakes on demand and responds instantly — no always-on worker, no cost.

The daily digest still runs via the Vercel cron already defined in `vercel.json` (`/api/scan`).

1. Deploy to Vercel and set the env vars (`TELEGRAM_BOT_TOKEN`, `AIRTABLE_*`, `TELEGRAM_WEBHOOK_SECRET`, `GITHUB_DISPATCH_REPO`, `GITHUB_DISPATCH_TOKEN`, plus `CRON_SECRET` if you keep the Vercel cron).
2. Create the [Subscribers table](#subscribers-table) in Airtable so subscriptions survive cold starts.
3. Register the webhook once:

   ```bash
   PUBLIC_BASE_URL=https://your-app.vercel.app \
   TELEGRAM_WEBHOOK_SECRET=your_secret \
   npm run set-webhook
   ```

   Or pass the URL directly: `node scripts/set-webhook.js https://your-app.vercel.app`

   Useful flags: `node scripts/set-webhook.js --info` (status), `--delete` (revert to polling).

#### How `/scan` avoids the serverless timeout

A full scan (GitHub + news + LLM) routinely runs longer than a serverless
function is allowed to live. So the webhook **never runs the scan itself** —
it hands the job to GitHub Actions and returns in milliseconds:

```
Telegram → /api/telegram (ms)  ──repository_dispatch──→  GitHub Actions
                                                          (6-hour budget)
                                                                │
                                       digest → all subscribers ┘
```

Every command path is now fast, so nothing can time out:

| Command | Runs where | Response |
|---|---|---|
| `/start` `/stop` `/status` `/help` | webhook | instant |
| `/scan …` | queued to GitHub Actions | instant ack, digest when the run finishes |

To enable it, set `GITHUB_DISPATCH_REPO` (`owner/repo`) and
`GITHUB_DISPATCH_TOKEN` (a PAT with `contents: write`, **separate** from the
read-only scan token). The receiving workflow is
`.github/workflows/telegram-scan.yml`; you can also run it by hand from the
Actions tab. If the run fails, the requester gets a message with a link to it.

If dispatch is not configured, the webhook falls back to running the scan in the
background — fine for quick scans, but it can be cut short by `maxDuration`,
which is exactly why dispatch is recommended.

#### Running two bots from one deployment

Set a second token and both bots answer, each with its own audience:

```env
TELEGRAM_BOT_TOKEN=111111:AAA…      # primary
TELEGRAM_BOT_TOKEN_2=222222:BBB…    # second bot
```

`npm run set-webhook` then registers **one URL per bot**:

```
https://your-app.vercel.app/api/telegram?bot=111111
https://your-app.vercel.app/api/telegram?bot=222222
```

The `bot` parameter tells the webhook which token to reply through. Subscriptions
are stored per bot (the `BotId` column), because **a bot may only message chats
that started that same bot** — sharing one list across bots produces
`bot can't initiate conversation with a user` errors. The daily digest is sent to
each bot's own subscribers, through that bot's token.

`TELEGRAM_CHAT_ID` (the admin chat) is only auto-included for the **primary**
bot, for the same reason. Long-polling mode (`npm run bot`) polls every
configured bot in parallel.

Rows written before multi-bot support have an empty `BotId` and are treated as
belonging to the primary bot, so existing subscribers keep working.

**Considering Cloudflare Workers instead?** See
[`deploy/cloudflare.md`](deploy/cloudflare.md) for an honest comparison and a
step-by-step migration plan. Summary: with scans on GitHub Actions, the host
only serves a thin webhook, so Vercel is already sufficient.

---

## Configuration

All configuration lives in `.env`. Copy `.env.example` to get started.

```env
# GitHub fine-grained token (read-only, public repos)
# Get at: github.com/settings/tokens → Fine-grained → Public repos → Issues: Read-only
GITHUB_TOKEN=github_pat_...

# Ollama (gemma4:31b-cloud needs an Ollama account)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma4:31b-cloud

# Airtable
AIRTABLE_API_KEY=pat...
AIRTABLE_BASE_ID=app...
AIRTABLE_TABLE_NAME=tblgjC6xgOTdJtw72

# Telegram (primary notification)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# WhatsApp via CallMeBot (fallback — leave blank if not using)
WHATSAPP_PHONE=254712345678
WHATSAPP_APIKEY=...

# Cron schedule (default: 8am Nairobi daily)
SCAN_SCHEDULE=0 8 * * *

# BitcoinDevs fallback discovery
BITCOINDEVS_ISSUES_URL=https://bitcoindevs.xyz/good-first-issues?sort=newest-first&page=1&labels=good+first+issue
BITCOINDEVS_MAX_REPOS=12
BITCOINDEVS_DISCOVERY=true
PREFERRED_LANGUAGES=Rust,Python,TypeScript

# Weekly workflow sets this automatically
DIGEST_MODE=daily

# Protect dashboard APIs and manual scans
DAN_AGENT_API_KEY=replace_with_a_long_random_string

```

If `DAN_AGENT_API_KEY` is set, the dashboard prompts for it once and sends it on all API requests. Manual scans and all dashboard data endpoints reject unauthenticated requests.

---

## npm Scripts

| Command | Description |
|---|---|
| `npm run scan` | Run a single scan immediately |
| `npm start` | Start the cron scheduler (runs daily at 8am) |
| `npm run bot` | Run the long-polling bot + scheduler (persistent worker) |
| `npm run set-webhook` | Register the Telegram webhook (serverless mode) |
| `npm run setup` | Create all Airtable fields (run once) |

---

## Repositories Monitored

Manage repositories from the dashboard:

1. Open the app
2. Add `owner/repo` or a GitHub repo URL in the watchlist form
3. Use `Run scan now` or let the daily schedule use the saved watchlist

If no repositories are saved, scheduled scans discover repositories from BitcoinDevs good-first-issues instead.
Those discoveries are persisted locally, exact BitcoinDevs issue URLs are scanned first, and each dashboard opportunity shows its source and local fit score.

---

## News Sources

| Source | Type | Focus |
|---|---|---|
| TechCrunch | RSS | Startups, funding, Silicon Valley |
| Wired | RSS | In-depth investigative tech |
| Ars Technica | RSS | Science, policy, deep tech |
| TLDR Tech | RSS | Daily 5-minute developer digest |
| GitHub Blog | RSS | Platform and open-source ecosystem updates |
| GitHub Releases | API | Latest releases from monitored repos |
| Hacker News | API | Community-voted tech stories |

---

## Deployment

Running on your laptop is fine for testing, but to keep the agent running 24/7 use one of these options:

### Option A — PM2 (run on your laptop/server as a background daemon)

```bash
npm install -g pm2
pm2 start agent.js --name danagent -- --schedule
pm2 save
pm2 startup   # auto-start on reboot
```

Useful commands:
```bash
pm2 logs danagent       # view live logs
pm2 status              # check if running
pm2 restart danagent    # restart after code changes
```

### Option B — Railway (easiest cloud deploy, free tier)

1. Push the project to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. Go to **Variables** → add all your `.env` keys
5. Railway auto-detects Node.js and starts `npm start`

Free tier gives you 500 hours/month — enough for this agent.

### Option C — Render (free background worker)

1. Push to GitHub
2. Go to [render.com](https://render.com) → New → Background Worker
3. Build command: `npm install`
4. Start command: `node agent.js --schedule`
5. Add environment variables in the dashboard

### Option D — Hetzner VPS (cheapest 24/7, ~$4/month)

Best value for money. Get a CAX11 ARM instance (€3.29/month):

```bash
# On the server
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs git

# Install Ollama (for local model fallback if needed)
curl -fsSL https://ollama.com/install.sh | sh

git clone <your-repo>
cd danagent
npm install
cp .env.example .env
nano .env   # add your keys

# Run with PM2
npm install -g pm2
pm2 start agent.js --name danagent -- --schedule
pm2 save && pm2 startup
```

### Option E — GitHub Actions (free, scheduled)

Create `.github/workflows/scan.yml`:

```yaml
name: Daily Repository Scan
on:
  schedule:
    - cron: '0 5 * * *'   # 8am Nairobi = 5am UTC
  workflow_dispatch:        # manual trigger button

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install
      - run: node agent.js --scan
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OLLAMA_BASE_URL: ${{ secrets.OLLAMA_BASE_URL }}
          OLLAMA_MODEL: ${{ secrets.OLLAMA_MODEL }}
          AIRTABLE_API_KEY: ${{ secrets.AIRTABLE_API_KEY }}
          AIRTABLE_BASE_ID: ${{ secrets.AIRTABLE_BASE_ID }}
          AIRTABLE_TABLE_NAME: ${{ secrets.AIRTABLE_TABLE_NAME }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
```

Add all secrets in your GitHub repo → Settings → Secrets and variables → Actions.

**Note:** For GitHub Actions with Ollama cloud, set `OLLAMA_BASE_URL` to point to a remote Ollama instance or replace the Ollama call with a direct Gemini/Groq API call.

---

## Operating Model

**Recommended weekly workflow:**
1. Keep the watchlist current in the dashboard
2. Run `npm run scan` on a schedule or before planning sessions
3. Review the highest-fit issues first
4. Assign owners and next steps in the workbench
5. Use repo-specific validation commands before opening PRs

---

## Project Structure

```
danagent/
├── agent.js                 ← Main entry point
├── package.json
├── .env                     ← Your secrets (never commit this)
├── .env.example             ← Template (safe to commit)
├── src/
│   ├── github.js
│   ├── gemma.js
│   ├── news.js
│   ├── airtable.js
│   ├── whatsapp.js
│   └── config.js
└── scripts/
    └── setup-airtable.js
```

---

## Licence

MIT

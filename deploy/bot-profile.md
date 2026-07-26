# BotFather profile copy

Ready-to-paste text for each bot. BotFather limits: **Name 64**, **About 120**,
**Description 512** characters.

Set them with `/mybots` → pick the bot → **Edit Bot** → Edit Name / Edit
Description / Edit About.

- **About** shows on the bot's profile card and when someone shares it.
- **Description** is the "What can this bot do?" screen a new user sees in the
  empty chat, before they ever press Start. This is the one that decides whether
  they hit Start, so it matters most.

---

## @btc_opensource_projects_bot — the public digest bot

Currently named `btcopensource_bot`, which reads as a near-duplicate of the other
bot. Suggested rename:

**Name**

```
BTC Open Source Digest
```

**About**

```
Daily digest of high-signal Bitcoin open-source issues: good first issues, bugs, and what to pick up next.
```

**Description**

```
I scan open-source Bitcoin repositories every morning and send you the issues actually worth your time.

Every opportunity includes:
• Effort level — low, medium or high
• Why it qualifies and the suggested next step
• A direct link to the GitHub issue
• Starter code where it helps

Commands
/start — subscribe to the daily digest
/stop — unsubscribe
/status — check the bot is running
/scan — run a scan right now
/help — show all commands

Press Start to get tomorrow's digest.
```

---

## @dan_sentinel_bot — the personal watch bot

Currently named `btc_opensource_bot`, which collides with the public bot above.
The "sentinel" handle suits a private alert channel, so lean into that — it also
gives the two bots a reason to both exist.

**Name**

```
Dan Sentinel — Repo Watch
```

**About**

```
Personal watch bot for open-source repo activity: daily opportunity digests and on-demand scans.
```

**Description**

```
Private watch channel for my repository intelligence agent.

I track a watchlist of open-source repositories and report the issues worth acting on — with effort level, suggested action, issue links and starter code.

Commands
/start — subscribe to updates
/stop — unsubscribe
/status — check the bot is running
/scan — run a scan now
/scan goodfirst — good first issues only
/scan medium — medium-effort issues
/help — show all commands
```

---

## Commands

You do **not** need to set these by hand. `setTelegramCommands()` registers them
for every configured bot each time you run `npm run set-webhook`, so the menu
stays in sync with the code.

If you ever want to set them manually, `/setcommands` takes exactly this:

```
start - Subscribe to daily updates
stop - Unsubscribe from daily updates
status - Check whether the bot is running
help - Show available commands
scan - Run scan: /scan all, /scan goodfirst, /scan medium
```

---

## A note on running two bots

The copy above frames one bot as public and one as personal, but **both
currently run the same scan against the same watchlist** — the split is
presentational only. To make it real, give them separate watchlists, or retire
one. Subscribers are tracked per bot, so someone who subscribes to one receives
nothing from the other.

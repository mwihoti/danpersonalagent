'use strict';
// Hands a scan off to GitHub Actions via repository_dispatch.
//
// A full scan (GitHub + news + LLM) routinely outlives a serverless invocation,
// so on Vercel/Cloudflare we don't run it in the request. We trigger the
// `telegram-scan` workflow instead: it gets a 6-hour budget, runs the exact same
// `node agent.js --scan` path as the daily cron, and notifies subscribers when
// it finishes. The webhook returns in milliseconds either way.
//
// Env:
//   GITHUB_DISPATCH_REPO   owner/repo that holds the workflow (defaults to
//                          GITHUB_REPOSITORY when running inside Actions)
//   GITHUB_DISPATCH_TOKEN  PAT with `contents: write` (fine-grained) or `repo`
//                          scope (classic). This is NOT the read-only scan token.
const EVENT_TYPE = 'telegram-scan';

function dispatchConfig() {
  return {
    repo: process.env.GITHUB_DISPATCH_REPO || process.env.GITHUB_REPOSITORY || '',
    token: process.env.GITHUB_DISPATCH_TOKEN || '',
  };
}

function isDispatchConfigured() {
  const { repo, token } = dispatchConfig();
  return Boolean(repo && token);
}

async function dispatchScan({ scanMode = 'default', chatId = '' } = {}) {
  const { repo, token } = dispatchConfig();
  if (!repo || !token) {
    throw new Error('GitHub Actions dispatch is not configured');
  }

  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'danagent-bot',
    },
    body: JSON.stringify({
      event_type: EVENT_TYPE,
      client_payload: {
        scan_mode: scanMode,
        chat_id: String(chatId || ''),
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  // GitHub answers 204 No Content on success.
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error('GitHub rejected the dispatch — GITHUB_DISPATCH_TOKEN needs contents:write on the repo');
    }
    if (res.status === 404) {
      throw new Error(`Repo or workflow not found: ${repo} (check GITHUB_DISPATCH_REPO and that the token can see it)`);
    }
    throw new Error(`GitHub dispatch failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  return true;
}

module.exports = {
  EVENT_TYPE,
  isDispatchConfigured,
  dispatchScan,
};

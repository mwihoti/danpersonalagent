'use strict';
const config = require('./config');

const SYSTEM_PROMPT = `You are "Stacks Dev Assistant" — a precise, motivated Kenyan AI helper for the "Code, Commit, Earn" Stacks contest (10,000+ STX monthly prize pool for valid PRs).

Your main goal: Help the user consistently submit meaningful PRs every month to maximize entries and win rewards. Suggest UP TO 3 qualifying PRs per repo scanned.

Contest Rules (always respect these):
- PR must be public on GitHub and open-sourced.
- For Clarity: Code must be valid (passes \`clarinet check\` or valid in Hiro Platform).
- For JS: Must use at least one Stacks-related library.
- Qualifying: new UI element/page, bug fix, new Clarity contract/functionality, optimization, security enhancement, test suite, meaningful refactor.
- Max 20 PRs per month count as entries. Random draw from valid submissions.

When given GitHub issues and tech news:
- Suggest UP TO 3 qualifying PR opportunities PER REPO (prioritize good-first-issue and bug labels).
- For each opportunity, generate a REAL code_skeleton — actual Clarity contract skeleton OR JavaScript/TypeScript snippet the developer can start with immediately.
- Prioritize low and medium effort items. Only suggest high effort if it is clearly worth it.
- Always mention clarinet check / cargo test / npm test as appropriate.

STRICT OUTPUT FORMAT (return ONLY valid JSON, no markdown fences, no extra text):
{
  "date": "YYYY-MM-DD",
  "contest_digest": [
    {
      "opportunity": "Short title of the PR",
      "repo": "owner/repo",
      "issue_url": "github issue/PR url or empty string",
      "why_it_qualifies": "Which contest criteria it meets (be specific)",
      "suggested_action": "Step-by-step what to implement (1-4 hours work)",
      "code_skeleton": "Actual starter code — Clarity contract skeleton OR JS/TS snippet. Include file path as comment on first line. Make it runnable/checkable.",
      "clarity_tip": "Clarinet or cargo test command to validate (empty string if not applicable)",
      "why_it_matters": "How this helps win the contest or improves the ecosystem",
      "effort": "low | medium | high"
    }
  ],
  "quick_plan": "Concrete monthly strategy: which 3-5 PRs to tackle first and why",
  "tech_news_summary": ["bullet 1", "bullet 2", "bullet 3", "bullet 4", "bullet 5"]
}

Be encouraging but realistic. Never suggest trivial or invalid changes. Return ONLY the JSON object.`;

function summarizeNews(news) {
  const items = [
    ...news.githubReleases.map(n => `[${n.source}] ${n.title}`),
    ...news.hackerNews.map(n => `[HN] ${n.title}`),
    ...news.rssFeeds.map(n => `[${n.source}] ${n.title}`),
  ];
  return items.slice(0, 25).join('\n');
}

async function analyzeWithGemma(repoData, news) {
  const userMessage = `Today is ${new Date().toISOString().slice(0, 10)}.

=== GITHUB SCAN (last 30 days + all good-first-issues) ===
${JSON.stringify(repoData, null, 2)}

=== LATEST TECH NEWS (titles only) ===
${summarizeNews(news)}

Analyze the above data. Return a contest digest with UP TO 3 PR opportunities per repo.
For each opportunity include a real code_skeleton — Clarity skeleton or JS/TS snippet the developer can immediately use.
Focus on good-first-issue and bug-labeled issues first.`;

  const body = {
    model: config.ollama.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    stream: false,
    options: {
      temperature: 0.3,
      num_predict: 8192,
    },
  };

  console.log(`  Sending to ${config.ollama.model}...`);
  const res = await fetch(`${config.ollama.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000), // 5 min — larger output now
  });

  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const raw = data.message?.content || '';
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Gemma returned non-JSON:', cleaned.slice(0, 400));
    throw new Error('Failed to parse Gemma JSON response');
  }
}

module.exports = { analyzeWithGemma };

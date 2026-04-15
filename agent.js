'use strict';
const cron = require('node-cron');
const { scanRepos } = require('./src/github');
const { analyzeWithGemma } = require('./src/gemma');
const { fetchNews } = require('./src/news');
const { saveDigest } = require('./src/airtable');
const { sendNotification, buildDigestMessage } = require('./src/whatsapp');
const config = require('./src/config');

async function run() {
  const startedAt = new Date().toISOString();
  console.log(`\n[${startedAt}] Starting Stacks Dev Assistant scan...`);

  try {
    // 1. Scan GitHub repos + fetch news in parallel
    console.log('\n1/3 Scanning GitHub repos + news...');
    const [repoData, news] = await Promise.all([
      scanRepos(),
      fetchNews(),
    ]);
    const totalIssues = repoData.reduce((n, r) => n + r.issues.length, 0);
    console.log(`     Found ${totalIssues} issues across ${repoData.length} repos`);

    // 2. Analyze with Gemma
    console.log('\n2/3 Analyzing with Gemma...');
    const digest = await analyzeWithGemma(repoData, news);
    const count = digest.contest_digest?.length || 0;
    console.log(`     Got ${count} contest opportunities`);
    console.log('\n--- DIGEST PREVIEW ---');
    console.log(JSON.stringify(digest, null, 2));
    console.log('--- END PREVIEW ---\n');

    // 3. Save + notify
    console.log('3/3 Saving and notifying...');
    await Promise.all([
      saveDigest(digest).catch(e => console.warn(`  Airtable skipped: ${e.message}`)),
      sendNotification(buildDigestMessage(digest)),
    ]);

    console.log(`\nDone! Scan completed at ${new Date().toISOString()}`);
    return digest;
  } catch (err) {
    console.error('\nAgent error:', err.message);
    process.exitCode = 1;
  }
}

// CLI: node agent.js [--scan | --schedule]
const arg = process.argv[2];

if (!arg || arg === '--scan') {
  run().then(() => {
    if (!arg) process.exit(0);
  });
} else if (arg === '--schedule') {
  const schedule = config.schedule;
  console.log(`Scheduling agent with cron: "${schedule}"`);
  console.log('Running initial scan now...\n');

  run();

  cron.schedule(schedule, () => {
    run();
  }, { timezone: 'Africa/Nairobi' });

  console.log('\nAgent running. Press Ctrl+C to stop.');
} else {
  console.error(`Unknown argument: ${arg}`);
  console.error('Usage: node agent.js [--scan | --schedule]');
  process.exit(1);
}

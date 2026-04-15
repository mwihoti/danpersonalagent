'use strict';
const Airtable = require('airtable');
const config = require('./config');

let base = null;

function getBase() {
  if (!base) {
    if (!config.airtable.apiKey || !config.airtable.baseId) {
      throw new Error('Airtable not configured — set AIRTABLE_API_KEY and AIRTABLE_BASE_ID in .env');
    }
    Airtable.configure({ apiKey: config.airtable.apiKey });
    base = new Airtable().base(config.airtable.baseId);
  }
  return base;
}

/**
 * Save a digest result to Airtable.
 * Table columns expected:
 *   Date (date), Opportunity (text), Repo (text), Effort (single select),
 *   Why It Qualifies (long text), Suggested Action (long text),
 *   Clarity Tip (long text), Issue URL (url), Quick Plan (long text), Status (single select)
 */
async function saveDigest(digest) {
  if (!config.airtable.apiKey) {
    console.log('  Airtable skipped (not configured)');
    return;
  }

  const table = getBase()(config.airtable.tableName);
  const records = digest.contest_digest.map(item => ({
    fields: {
      Date: digest.date,
      Opportunity: item.opportunity,
      Repo: item.repo || '',
      'Why It Qualifies': item.why_it_qualifies,
      'Suggested Action': item.suggested_action,
      'Clarity Tip': item.clarity_tip || '',
      'Issue URL': item.issue_url || '',
      'Code Skeleton': item.code_skeleton || '',
      'Why It Matters': item.why_it_matters,
      Effort: item.effort || 'medium',
      'Quick Plan': digest.quick_plan,
    },
  }));

  // Airtable max 10 records per create call
  for (let i = 0; i < records.length; i += 10) {
    await table.create(records.slice(i, i + 10));
  }

  console.log(`  Saved ${records.length} opportunities to Airtable`);
}

module.exports = { saveDigest };

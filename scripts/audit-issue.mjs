// Builds the body of the scheduled audit's tracking issue. Called from the
// `audit-main` job in .github/workflows/audit-gate.yml via actions/github-script.
//
// The body carries a machine-readable block of the advisories the auto-fix left
// for a human, one `GHSA | package | severity | reason` line each, between
// SKIPPED_START and SKIPPED_END. A missing block means "unknown", never "none":
// an empty block is the only way to say nothing was skipped.

import crypto from 'crypto';

export const MARKER = '<!-- dependency-audit-main -->';
export const SKIPPED_START = '<!-- dependency-audit-skipped -->';
export const SKIPPED_END = '<!-- /dependency-audit-skipped -->';
const HASH_RE = /<!-- dependency-audit-findings:([0-9a-f]+) -->/;

// The skipped lines from an existing body, or null when it has no block.
export function parseSkippedBlock(body) {
  const start = String(body || '').indexOf(SKIPPED_START);
  if (start === -1) return null;
  const end = body.indexOf(SKIPPED_END, start);
  if (end === -1) return null;
  return body
    .slice(start + SKIPPED_START.length, end)
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('```'));
}

// Returns { body, hash, changed }. `skippedText` is the auto-fix step's skipped
// file, or null when that step did not run or failed; then the previous block is
// kept with a note, so a failed run never reads as "nothing skipped". `changed`
// is true when the advisories or the skip reasons differ from `existingBody`.
export function planIssueBody({ existingBody = null, gateOutput, skippedText, autofix, runUrl, playbookUrl }) {
  // Only the "[SEVERITY] pkg: GHSA" lines, so a reworded message doesn't count as a change.
  const advisoryLines = gateOutput
    .split('\n')
    .filter(l => /^\s*\[[A-Z]+\] /.test(l))
    .map(l => l.trim())
    .sort();

  const known = skippedText !== null && skippedText !== undefined;
  const skipLines = known
    ? skippedText
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
    : parseSkippedBlock(existingBody);

  const hashInput = [...advisoryLines, '--', ...(skipLines ?? ['unknown']).slice().sort()].join('\n');
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
  const previousHash = String(existingBody || '').match(HASH_RE)?.[1] ?? null;

  const skippedSection = [];
  if (skipLines) {
    skippedSection.push(
      '**Not fixed automatically:**',
      ...(known ? [] : ['_This run produced no skip data; the list below is from an earlier run._']),
      '',
      SKIPPED_START,
      '```',
      ...skipLines,
      '```',
      SKIPPED_END
    );
  } else {
    skippedSection.push('**Not fixed automatically:** unknown; see the run log.');
  }

  const body = [
    MARKER,
    `<!-- dependency-audit-findings:${hash} -->`,
    '',
    'The scheduled dependency audit found high/critical advisories on `main` that are not in `scripts/audit-allowlist.json`.',
    '',
    '```',
    gateOutput.trim(),
    '```',
    '',
    autofix,
    '',
    ...skippedSection,
    '',
    `**Run:** ${runUrl}`,
    `**Fix steps:** ${playbookUrl}`,
    '',
    '_This issue is updated by `.github/workflows/audit-gate.yml` and closed automatically once main is clean._',
  ].join('\n');

  return { body, hash, changed: hash !== previousHash };
}

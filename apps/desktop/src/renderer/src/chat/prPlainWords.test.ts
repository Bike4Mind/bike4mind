import { describe, expect, it } from 'vitest';
import { PR_ATTENTIONS } from '@shared/prAttention';
import type { PrCheck } from '@shared/pullRequest';
import { ciLine, freshnessLine, mergeLine, PR_LEGEND, prHeadline, prPageUrl, reviewLine } from './prPlainWords';

const check = (bucket: PrCheck['bucket']): PrCheck => ({ name: bucket, bucket, required: false });

describe('prHeadline', () => {
  it.each([
    ['conflict', 'Merge conflict', /rebase/],
    ['changesRequested', 'Changes requested', /reviewer/],
    ['ciFailed', 'CI failed', /failing/],
    ['ready', 'Ready to merge', /nothing is blocking/],
  ] as const)('spells out %s', (attention, title, hint) => {
    const headline = prHeadline({ state: 'open', attention });
    expect(headline.title).toBe(title);
    expect(headline.hint).toMatch(hint);
  });

  it('has words for every attention prAttention can return', () => {
    for (const attention of PR_ATTENTIONS) expect(prHeadline({ state: 'open', attention }).title).not.toBe('Open');
  });

  it('falls back to the lifecycle state when nothing is waiting', () => {
    expect(prHeadline({ state: 'open' }).title).toBe('Open');
    expect(prHeadline({ state: 'closed' }).hint).toBe('Closed without merging.');
    expect(prHeadline({ state: 'merged', attention: 'conflict' }).title).toBe('Merged');
  });
});

describe('PR_LEGEND', () => {
  it('lists every attention glyph and lifecycle state once', () => {
    const labels = PR_LEGEND.map(entry => entry.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const attention of PR_ATTENTIONS) expect(labels).toContain(prHeadline({ state: 'open', attention }).title);
    expect(labels).toEqual(expect.arrayContaining(['Draft', 'Merged', 'Closed', 'Behind the base branch']));
  });
});

describe('ciLine', () => {
  it('counts passed, failed and running checks', () => {
    expect(ciLine([check('pass'), check('pass'), check('fail'), check('pending'), check('skipped')])).toBe(
      '2 passed, 1 failed, 1 running'
    );
  });

  it('says when there are no checks, or only skipped ones', () => {
    expect(ciLine([])).toBe('No checks');
    expect(ciLine([check('skipped')])).toBe('1 skipped');
  });
});

describe('reviewLine and mergeLine', () => {
  it('reads the review decision', () => {
    expect(reviewLine('CHANGES_REQUESTED')).toBe('Changes requested');
    expect(reviewLine(null)).toBe('No review required');
  });

  it('reads conflicts, behind-base and pending mergeability', () => {
    const base = { state: 'OPEN', baseRefName: 'main' } as const;
    expect(mergeLine({ ...base, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).toBe('Conflicts with main');
    expect(mergeLine({ ...base, mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' })).toMatch(/^Behind main/);
    expect(mergeLine({ ...base, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })).toMatch(/still checking/);
    expect(mergeLine({ ...base, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })).toBe('No conflicts with main');
    expect(mergeLine({ ...base, state: 'MERGED', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })).toBe(
      'Merged into main'
    );
  });
});

describe('freshnessLine', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  it('says when the app last read an open PR', () => {
    expect(freshnessLine({ fetchedAt: now - 5 * 60_000 }, now)).toBe('Checked 5m ago');
  });
  it('says when a merged PR merged', () => {
    expect(freshnessLine({ fetchedAt: now, mergedAt: '2026-11-24T09:00:00Z' }, now)).toBe('Merged 3h ago');
  });
});

describe('prPageUrl', () => {
  it('builds the GitHub page from owner/repo', () => {
    expect(prPageUrl('acme/app', 7)).toBe('https://github.com/acme/app/pull/7');
  });
  it('refuses a missing or malformed repo', () => {
    expect(prPageUrl(undefined, 7)).toBeUndefined();
    expect(prPageUrl('acme/app/../x', 7)).toBeUndefined();
  });
});

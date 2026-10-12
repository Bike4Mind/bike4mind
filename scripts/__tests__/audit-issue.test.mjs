import { describe, it, expect } from 'vitest';
import { parseSkippedBlock, planIssueBody, SKIPPED_START, SKIPPED_END } from '../audit-issue.mjs';

const GATE = [
  'Found 2 high/critical advisories not in the allowlist:',
  '  [HIGH] some-pkg: GHSA-new-aaaa-aaaa',
  '  [CRITICAL] other: GHSA-new-bbbb-bbbb',
].join('\n');
const SKIP = 'GHSA-new-bbbb-bbbb | other | critical | no usable patched version (`<0.0.0`): allowlist or replace\n';
const base = {
  gateOutput: GATE,
  autofix: '**Auto-fix PR:** https://example.test/pr/1',
  runUrl: 'https://example.test/run/1',
  playbookUrl: 'https://example.test/playbook',
};

describe('planIssueBody', () => {
  it('writes the skipped lines in a parseable block', () => {
    const { body, changed } = planIssueBody({ ...base, skippedText: SKIP });
    expect(changed).toBe(true);
    expect(body).toContain(SKIPPED_START);
    expect(body).toContain(SKIPPED_END);
    expect(parseSkippedBlock(body)).toEqual([SKIP.trim()]);
  });

  it('writes an empty block when nothing was skipped, and no block when unknown', () => {
    expect(parseSkippedBlock(planIssueBody({ ...base, skippedText: '' }).body)).toEqual([]);
    const unknown = planIssueBody({ ...base, skippedText: null }).body;
    expect(parseSkippedBlock(unknown)).toBeNull();
    expect(unknown).toMatch(/Not fixed automatically:\*\* unknown/);
  });

  it('reports no change on a rerun with the same advisories and skips, even with a new run url or PR', () => {
    const first = planIssueBody({ ...base, skippedText: SKIP });
    const again = planIssueBody({
      ...base,
      existingBody: first.body,
      skippedText: SKIP,
      runUrl: 'https://example.test/run/2',
      autofix: '**Auto-fix PR:** https://example.test/pr/2',
    });
    expect(again.changed).toBe(false);
    expect(again.body).toContain('https://example.test/run/2');
    expect(again.body).toContain('https://example.test/pr/2');
  });

  it('reports a change when only a skip reason changes', () => {
    const first = planIssueBody({ ...base, skippedText: SKIP });
    const next = planIssueBody({ ...base, existingBody: first.body, skippedText: '' });
    expect(next.changed).toBe(true);
  });

  it('keeps the previous block, with a note, when this run has no skip data', () => {
    const first = planIssueBody({ ...base, skippedText: SKIP });
    const next = planIssueBody({ ...base, existingBody: first.body, skippedText: null });
    expect(next.changed).toBe(false);
    expect(parseSkippedBlock(next.body)).toEqual([SKIP.trim()]);
    expect(next.body).toMatch(/no skip data; the list below is from an earlier run/);
  });

  it('treats a body from before the skipped block as changed', () => {
    const legacy = '<!-- dependency-audit-main -->\n<!-- dependency-audit-findings:0123456789abcdef -->\n';
    expect(planIssueBody({ ...base, existingBody: legacy, skippedText: SKIP }).changed).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { CurationType, type CurationOptions } from '@bike4mind/common';
import { computeCurationContentHash } from './index';

const baseOptions: CurationOptions = {
  curationType: CurationType.EXECUTIVE_SUMMARY,
  includeCode: true,
  includeDiagrams: true,
  includeDataViz: true,
  includeQuestMaster: true,
  includeResearch: true,
  includeImages: true,
  exportFormat: 'markdown',
};

const messages = [
  { id: 'm1', prompt: 'hello', reply: 'world' },
  { id: 'm2', prompt: 'again', reply: 'more' },
];

describe('computeCurationContentHash', () => {
  it('is stable for identical inputs (the cache-hit case)', () => {
    expect(computeCurationContentHash(messages, baseOptions)).toBe(computeCurationContentHash(messages, baseOptions));
  });

  it('changes when message content changes', () => {
    const edited = [{ ...messages[0], reply: 'CHANGED' }, messages[1]];
    expect(computeCurationContentHash(edited, baseOptions)).not.toBe(computeCurationContentHash(messages, baseOptions));
  });

  it('changes when the curation type changes', () => {
    const asTranscript = { ...baseOptions, curationType: CurationType.TRANSCRIPT };
    expect(computeCurationContentHash(messages, asTranscript)).not.toBe(
      computeCurationContentHash(messages, baseOptions)
    );
  });

  it('changes when an artifact include flag changes', () => {
    const noCode = { ...baseOptions, includeCode: false };
    expect(computeCurationContentHash(messages, noCode)).not.toBe(computeCurationContentHash(messages, baseOptions));
  });

  it('changes when the export format changes', () => {
    const asHtml = { ...baseOptions, exportFormat: 'html' as const };
    expect(computeCurationContentHash(messages, asHtml)).not.toBe(computeCurationContentHash(messages, baseOptions));
  });

  // These fields feed artifact extraction and are mutated AFTER message creation
  // (e.g. Deep Research completing), so the hash must react to them or a re-curate
  // would serve a stale document. See computeCurationContentHash comments.
  it('changes when deepResearchState changes (prompt/reply unchanged)', () => {
    const before = [{ ...messages[0], deepResearchState: { status: 'in_progress' } }, messages[1]];
    const after = [{ ...messages[0], deepResearchState: { status: 'complete', findings: 'x' } }, messages[1]];
    expect(computeCurationContentHash(after, baseOptions)).not.toBe(computeCurationContentHash(before, baseOptions));
  });

  it('changes when a message gains an image (prompt/reply unchanged)', () => {
    const before = messages;
    const after = [{ ...messages[0], images: ['s3://img-1.png'] }, messages[1]];
    expect(computeCurationContentHash(after, baseOptions)).not.toBe(computeCurationContentHash(before, baseOptions));
  });

  it('changes when questMasterPlanId is linked (prompt/reply unchanged)', () => {
    const before = messages;
    const after = [{ ...messages[0], questMasterPlanId: 'plan-1' }, messages[1]];
    expect(computeCurationContentHash(after, baseOptions)).not.toBe(computeCurationContentHash(before, baseOptions));
  });
});

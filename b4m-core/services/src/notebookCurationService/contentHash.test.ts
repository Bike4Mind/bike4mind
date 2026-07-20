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
});

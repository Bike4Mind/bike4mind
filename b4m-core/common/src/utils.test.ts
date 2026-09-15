import { describe, it, expect } from 'vitest';
import { extractSnippetMeta } from './utils';

describe('extractSnippetMeta', () => {
  it('splits leading text and a snippet-meta block into sections', () => {
    const input = ['Intro text', '<!--snippet-meta {"title":"X"} -->', 'snippet body here'].join('\n');
    const { sections } = extractSnippetMeta(input);

    expect(sections).toHaveLength(2);
    expect(sections[0]).toEqual({ type: 'text', content: 'Intro text' });
    expect(sections[1].type).toBe('snippet');
    expect(sections[1].content).toBe('snippet body here');
    expect((sections[1] as { meta: { title: string } }).meta.title).toBe('X');
  });

  it('returns plain text as a single section when there is no snippet-meta', () => {
    const { sections } = extractSnippetMeta('just a normal prompt with no snippet metadata');
    expect(sections).toEqual([{ type: 'text', content: 'just a normal prompt with no snippet metadata' }]);
  });

  it('completes on an oversized input (parse cap, no CPU pin)', () => {
    // Runs on every chat prompt; the regex backtracks super-linearly. The parse cap
    // bounds the scanned length so a pathological/oversized prompt returns immediately
    // rather than pinning the process. A regression blows the vitest timeout.
    const adversarial = '<!--snippet-meta {'.repeat(500_000);
    const { sections } = extractSnippetMeta(adversarial);
    expect(Array.isArray(sections)).toBe(true);
  });
});

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

  it('completes on an adversarial input without pinning CPU', () => {
    // Runs on every chat prompt. The regex this replaced backtracked super-linearly on a
    // marker whose JSON never closes; the scan is linear, so this returns immediately. A
    // regression blows the vitest timeout.
    const adversarial = '<!--snippet-meta {'.repeat(500_000);
    const started = Date.now();
    const { sections } = extractSnippetMeta(adversarial);
    expect(Array.isArray(sections)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('returns a large plain-text prompt whole', () => {
    const tail = 'TAIL_MARKER';
    const oversized = 'a'.repeat(300_000) + tail;
    const { sections } = extractSnippetMeta(oversized);
    const rendered = sections.map(s => s.content).join('');
    expect(rendered).toHaveLength(oversized.length);
    expect(rendered.endsWith(tail)).toBe(true);
  });

  // Section SHAPE has to be independent of input length. Under the previous parse cap a
  // snippet running past 256k re-emitted as a `text` section, and callers that skip
  // snippets when collecting URLs to fetch would have started fetching the URLs in it.
  it('still classifies a snippet as a snippet well past the old parse cap', () => {
    const body = 'https://example.com/x\n' + 'y'.repeat(300_000);
    const { sections } = extractSnippetMeta('<!--snippet-meta {"id":"1"} -->' + body);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe('snippet');
    expect(sections[0].content).toBe(body.trim());
  });

  it('recognises a marker that begins past the old parse cap', () => {
    const lead = 'a'.repeat(300_000);
    const { sections } = extractSnippetMeta(lead + '<!--snippet-meta {"id":"2"} -->body');
    expect(sections.map(s => s.type)).toEqual(['text', 'snippet']);
    expect(sections[1].content).toBe('body');
  });

  it('does not end the marker on a "-->" inside the meta JSON', () => {
    const { sections } = extractSnippetMeta('<!--snippet-meta {"title":"a-->b"} -->body');
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe('snippet');
    expect((sections[0] as { meta: { title: string } }).meta.title).toBe('a-->b');
  });

  it('leaves a marker with no closing "-->" as plain text', () => {
    const input = 'lead <!--snippet-meta {"id":"3"} and nothing else';
    expect(extractSnippetMeta(input).sections).toEqual([{ type: 'text', content: input }]);
  });
});

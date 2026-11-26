import { describe, it, expect } from 'vitest';
import { splitStreamingBlocks } from './streamingSplit';
import { replyParser, splitStreamingMarkdown } from './streamingSplitTestUtils';

describe('splitStreamingMarkdown', () => {
  it('cuts at the last top-level blank line', () => {
    expect(splitStreamingMarkdown('# A\n\npara one\n\npara two still typ')).toEqual({
      committed: '# A\n\npara one\n\n',
      tail: 'para two still typ',
    });
  });
  it('returns everything as tail when there is no blank line', () => {
    expect(splitStreamingMarkdown('just one paragraph so far')).toEqual({
      committed: '',
      tail: 'just one paragraph so far',
    });
  });
  it('keeps an open fence in the tail', () => {
    const text = 'intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n';
    expect(splitStreamingMarkdown(text)).toEqual({
      committed: 'intro\n\n',
      tail: '```ts\nconst a = 1;\n\nconst b = 2;\n',
    });
  });
  it('keeps an open $$ math block in the tail', () => {
    const text = 'intro\n\n$$\na = b\n\nc = d';
    expect(splitStreamingMarkdown(text)).toEqual({ committed: 'intro\n\n', tail: '$$\na = b\n\nc = d' });
  });
  it('commits a closed fence', () => {
    const text = '```js\nx\n```\n\nafter';
    expect(splitStreamingMarkdown(text)).toEqual({ committed: '```js\nx\n```\n\n', tail: 'after' });
  });
  it('keeps a table together while its rows are still streaming', () => {
    const text = 'intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 |';
    expect(splitStreamingMarkdown(text).tail.startsWith('| a | b |')).toBe(true);
  });
  it('parses text afresh when it rewrites the tail instead of appending to it', () => {
    const collapsed = splitStreamingBlocks('    a\n\n...', replyParser);
    expect(collapsed.committed).toBe('    a\n\n');
    const expanded = '    a\n\n    b';
    const reused = splitStreamingBlocks(expanded, replyParser, collapsed, true);
    const fresh = splitStreamingBlocks(expanded, replyParser, undefined, true);
    expect(reused.blocks).toEqual(fresh.blocks);
    expect(reused.tail).toBe(fresh.tail);
    expect(reused.committed).toBe('');
  });
});

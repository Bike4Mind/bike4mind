import { describe, expect, it } from 'vitest';
import { readableThinking } from './thinkingBlocks';

describe('readableThinking', () => {
  it('reads the text out of a thinking block and leaves the signature behind', () => {
    expect(readableThinking([{ type: 'thinking', thinking: 'The path is wrong.\n', signature: 'CAIS9wk' }])).toBe(
      'The path is wrong.'
    );
  });

  it('joins several blocks into one thought', () => {
    expect(
      readableThinking([
        { type: 'thinking', thinking: 'First, the error.' },
        { type: 'thinking', thinking: 'Then, the fix.' },
      ])
    ).toBe('First, the error.\n\nThen, the fix.');
  });

  it('drops a redacted block, which carries no text to read', () => {
    expect(readableThinking([{ type: 'redacted_thinking', data: 'EvwBCkgIA...' }])).toBe('');
  });

  it('reads nothing out of a round that had no blocks', () => {
    expect(readableThinking(undefined)).toBe('');
    expect(readableThinking([])).toBe('');
  });
});

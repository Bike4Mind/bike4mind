import { describe, expect, it } from 'vitest';
import { hasVisibleReplyText, visibleReplyText } from './streamVisibility';

describe('visibleReplyText', () => {
  it('treats an empty or whitespace-only slot as nothing visible', () => {
    expect(visibleReplyText(undefined)).toBe('');
    expect(visibleReplyText(null)).toBe('');
    expect(visibleReplyText('')).toBe('');
    expect(visibleReplyText('   \n  ')).toBe('');
  });

  it('passes plain text through untouched', () => {
    expect(visibleReplyText('Here is the answer.')).toBe('Here is the answer.');
  });

  it('passes text through when an open marker appears mid-string with no close', () => {
    // Deliberate: the transcript shows this, and modelVisibleSlots' startsWith strip relies
    // on it. "Fixing" it to return '' would silently break the append-mode seed exclusion.
    expect(visibleReplyText('preamble<think>reasoning')).toBe('preamble<think>reasoning');
  });

  it('hides a thinking block that has only opened', () => {
    // The first chunk of an extended-thinking turn is the bare marker.
    expect(visibleReplyText('<think>')).toBe('');
    expect(visibleReplyText('<think>weighing the options')).toBe('');
  });

  it('returns the answer that follows a closed thinking block', () => {
    expect(visibleReplyText('<think>weighing the options</think>The answer is 42.')).toBe('The answer is 42.');
  });

  it('returns nothing for a closed thinking block with no answer yet', () => {
    expect(visibleReplyText('<think>weighing the options</think>')).toBe('');
    expect(visibleReplyText('<think>weighing the options</think>\n\n')).toBe('');
  });

  it('takes the segment after the LAST close marker across multiple blocks', () => {
    // A tool-using turn can think, call a tool, then think again before answering.
    expect(visibleReplyText('<think>first</think>partial<think>second</think>final answer')).toBe('final answer');
  });
});

describe('hasVisibleReplyText', () => {
  it('is false while only thinking has streamed', () => {
    expect(hasVisibleReplyText(['<think>'])).toBe(false);
    expect(hasVisibleReplyText(['<think>step one, step two'])).toBe(false);
    expect(hasVisibleReplyText([])).toBe(false);
    expect(hasVisibleReplyText([undefined, ''])).toBe(false);
  });

  it('is true once any slot carries renderable text', () => {
    // The reply accumulator moves post-thinking text into the next slot, so the visible
    // answer routinely lands beside a thinking-only slot rather than inside it.
    expect(hasVisibleReplyText(['<think>reasoning</think>', 'The answer is 42.'])).toBe(true);
    expect(hasVisibleReplyText(['<think>reasoning</think>The answer is 42.'])).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { escapeThinkMarkers, hasVisibleReplyText, visibleReplyText } from './streamVisibility';

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

  it('keeps the text before a still-streaming block and hides the block itself', () => {
    // The marker must never reach the transcript: before this, the raw '<think>' was shown
    // for as long as the second block took to close.
    expect(visibleReplyText('preamble<think>reasoning')).toBe('preamble');
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

  it('keeps text that precedes a later thinking block', () => {
    // A tool-using turn can think, call a tool, then think again before answering, and the
    // partial answer has already been streamed to the user by then.
    expect(visibleReplyText('<think>first</think>partial <think>second</think>final answer')).toBe(
      'partial final answer'
    );
  });

  it('removes each thinking span independently rather than spanning between blocks', () => {
    expect(visibleReplyText('a<think>x</think>b<think>y</think>c')).toBe('abc');
  });

  it('keeps whitespace inside a slot, because callers concatenate slots with no separator', () => {
    // Trimming here welds the next slot onto this one: 'Here is the table:| a | b |'.
    expect(visibleReplyText('Here is the table:\n\n')).toBe('Here is the table:\n\n');
  });

  it('keeps a nested open hidden until its matching close, not the first close it sees', () => {
    // Reasoning text is provider-authored and can itself contain marker-shaped substrings.
    // A naive non-greedy pair match strips only "<think>outer<think>inner</think>" and lets
    // "tail" leak into the transcript; depth tracking keeps it hidden until the outer block
    // actually closes.
    expect(visibleReplyText('<think>outer<think>inner</think>tail</think>answer')).toBe('answer');
  });

  it('does not let an inner close end the outer block early', () => {
    expect(visibleReplyText('before<think>a<think>b</think>c</think>after')).toBe('beforeafter');
  });

  it('treats an unmatched trailing close as ordinary text rather than hiding a phantom block', () => {
    expect(visibleReplyText('answer</think>more')).toBe('answer</think>more');
  });

  it('does not let an unescaped provider-authored close marker leak hidden reasoning', () => {
    // Reported against the depth-tracking implementation: reasoning that itself contains a
    // literal '</think>' closes the real block early, and the text between the fake close and
    // the real one - genuinely still hidden reasoning - reads as ordinary text and leaks. This
    // is only safe because adapters now call escapeThinkMarkers on the raw delta before
    // wrapping it in the real markers (see the escapeThinkMarkers tests below); visibleReplyText
    // itself cannot tell control markers from data once they share an unescaped string.
    const leaked = visibleReplyText('<think>secret prefix </think>LEAKED SECRET</think>answer');
    expect(leaked).toBe('LEAKED SECRET</think>answer');

    const escapedInput = `<think>${escapeThinkMarkers('secret prefix </think>LEAKED SECRET')}</think>answer`;
    expect(visibleReplyText(escapedInput)).toBe('answer');
  });
});

describe('escapeThinkMarkers', () => {
  it('passes text with no markers through untouched', () => {
    expect(escapeThinkMarkers('plain reasoning')).toBe('plain reasoning');
  });

  it('returns empty/nullish input as-is', () => {
    expect(escapeThinkMarkers('')).toBe('');
  });

  it('defangs a literal open marker so it no longer matches the control token', () => {
    const escaped = escapeThinkMarkers('the model reasoned about <think>');
    expect(escaped).not.toContain('<think>');
    expect(escaped).toContain('think>');
  });

  it('defangs a literal close marker so it no longer matches the control token', () => {
    const escaped = escapeThinkMarkers('a trailing </think> in the monologue');
    expect(escaped).not.toContain('</think>');
    expect(escaped).toContain('/think>');
  });

  it('escaping and rewrapping a marker-shaped delta round-trips through visibleReplyText untouched', () => {
    const rawReasoning = 'outer <think>inner</think> tail </think> more';
    const wrapped = `<think>${escapeThinkMarkers(rawReasoning)}</think>final`;
    expect(visibleReplyText(wrapped)).toBe('final');
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

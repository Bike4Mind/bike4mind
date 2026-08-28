import { hasVisibleReplyText } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { appendStreamedChunk, modelVisibleSlots, type ReplySlots } from './streamedReplyAccumulator';

/**
 * Feeds a chunk sequence through the accumulator and reports, per chunk, whether the
 * transcript had anything visible in it afterwards. This is the pair ChatCompletionProcess
 * stamps TTFVT off, so the index at which `false` first flips to `true` is the chunk the
 * metric attributes the first visible token to.
 */
const visibilityAfterEachChunk = (chunks: Array<{ text: string; index?: number }>, transitionMode = 'replace') => {
  const replies: ReplySlots = {};
  return chunks.map(({ text, index = 0 }) => {
    appendStreamedChunk(replies, text, index, transitionMode);
    return hasVisibleReplyText(Object.values(replies));
  });
};

describe('appendStreamedChunk', () => {
  it('accumulates plain text into its own slot', () => {
    const replies: ReplySlots = {};
    appendStreamedChunk(replies, 'Hello', 0, 'replace');
    appendStreamedChunk(replies, ' world', 0, 'replace');
    expect(replies[0]).toBe('Hello world');
  });

  it('keeps separate content-block indices in separate slots', () => {
    const replies: ReplySlots = {};
    appendStreamedChunk(replies, 'first', 0, 'replace');
    appendStreamedChunk(replies, 'second', 1, 'replace');
    expect(Object.values(replies)).toEqual(['first', 'second']);
  });

  it('ignores empty chunks', () => {
    const replies: ReplySlots = {};
    appendStreamedChunk(replies, '', 0, 'replace');
    expect(replies[0]).toBeUndefined();
  });

  it('spills post-thinking text into the next slot so the answer is not buried in the think block', () => {
    // A thinking model that calls a tool restarts its indices at 0.
    const replies: ReplySlots = {};
    appendStreamedChunk(replies, '<think>', 0, 'replace');
    appendStreamedChunk(replies, 'reasoning', 0, 'replace');
    appendStreamedChunk(replies, '</think>', 0, 'replace');
    appendStreamedChunk(replies, 'The answer is 42.', 0, 'replace');

    expect(replies[0]).toBe('<think>reasoning</think>');
    expect(replies[1]).toBe('The answer is 42.');
  });

  it('funnels every chunk into slot 0 in append mode, whatever the index', () => {
    const replies: ReplySlots = {};
    appendStreamedChunk(replies, 'rapid reply ', 0, 'append');
    appendStreamedChunk(replies, 'continued', 3, 'append');
    expect(replies).toEqual({ 0: 'rapid reply continued' });
  });
});

describe('TTFVT visibility over a stream that opens with a thinking block', () => {
  it('reports nothing visible until real text arrives, then attributes it to that chunk', () => {
    // The exact shape anthropicBackend streams on the extended-thinking path: a bare
    // '<think>' marker on content_block_start, thinking_delta text, then the answer.
    const visibility = visibilityAfterEachChunk([
      { text: '<think>' },
      { text: 'weighing the options' },
      { text: ' some more' },
      { text: '</think>' },
      { text: 'The answer is 42.' },
    ]);

    // Chunks 1-4 are hidden reasoning: a metric stamped on "first non-empty chunk" would
    // have fired on chunk 1, while the user was still looking at an empty transcript.
    expect(visibility).toEqual([false, false, false, false, true]);
  });

  it('reports nothing visible for a turn that only ever streams thinking', () => {
    // Frozen turns from the report: chunks streamed, transcript never rendered, turn errored.
    // Every entry false means TTFVT is left unset, so the turn reads as never rendered
    // instead of as a healthy sub-5s response.
    const visibility = visibilityAfterEachChunk([
      { text: '<think>' },
      { text: 'planning a tool call' },
      { text: ' and its arguments' },
    ]);

    expect(visibility).toEqual([false, false, false]);
  });

  it('detects visible text that shares a chunk with the closing marker', () => {
    // kimiBackend/xaiBackend prepend the close marker to the first real content.
    const visibility = visibilityAfterEachChunk([{ text: '<think>reasoning' }, { text: '</think>The answer is 42.' }]);

    expect(visibility).toEqual([false, true]);
  });

  it('stamps on the first chunk when the turn streams text with no thinking at all', () => {
    // The control case: unchanged behavior for a non-thinking model.
    expect(visibilityAfterEachChunk([{ text: 'The answer' }, { text: ' is 42.' }])).toEqual([true, true]);
  });
});

describe('modelVisibleSlots', () => {
  it('passes the slots through untouched outside append mode', () => {
    const replies: ReplySlots = { 0: '<think>reasoning' };
    expect(modelVisibleSlots(replies, 'replace', '')).toEqual(['<think>reasoning']);
    expect(modelVisibleSlots(replies, 'replace', 'a rapid reply')).toEqual(['<think>reasoning']);
  });

  it('does not count the pre-seeded rapid reply as the model rendering something', () => {
    // Without the strip, "a rapid reply <think>..." has an unclosed marker mid-string and so
    // reads as visible - stamping TTFVT while the model is still only thinking.
    const replies: ReplySlots = { 0: 'a rapid reply <think>reasoning' };
    const slots = modelVisibleSlots(replies, 'append', 'a rapid reply');

    expect(slots).toEqual(['<think>reasoning']);
    expect(hasVisibleReplyText(slots)).toBe(false);
  });

  it('sees the model answer once it follows the seeded prefix', () => {
    const replies: ReplySlots = { 0: 'a rapid reply <think>reasoning</think>The answer is 42.' };
    expect(hasVisibleReplyText(modelVisibleSlots(replies, 'append', 'a rapid reply'))).toBe(true);
  });

  it('strips nothing when a retry has already cleared the seeded prefix', () => {
    // The retry paths clear the slots but leave the handoff flag set, so model text can be
    // sitting in slot 0 with no prefix in front of it. Slicing blind would eat it.
    const replies: ReplySlots = { 0: 'The answer is 42.' };
    expect(modelVisibleSlots(replies, 'append', 'a rapid reply')).toEqual(['The answer is 42.']);
  });

  it('does not mutate the caller reply slots', () => {
    const replies: ReplySlots = { 0: 'a rapid reply model text' };
    modelVisibleSlots(replies, 'append', 'a rapid reply');
    expect(replies[0]).toBe('a rapid reply model text');
  });
});

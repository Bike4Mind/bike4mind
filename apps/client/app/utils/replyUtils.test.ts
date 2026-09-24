import { describe, it, expect } from 'vitest';
import { extractReplies, extractThinking, visibleReplyForExport } from './replyUtils';
import { ABANDONED_REPLY } from '@server/chatCompletion/questTimeoutRecovery';

/**
 * `extractReplies` is what decides whether a quest's text reaches the bubble, so
 * it is the last link in the stranded-quest chain: the settle pass writes
 * `reply` on a quest whose `replies` array is the empty one it was dispatched
 * with (`agentExecute` creates it as `replies: []`), and if the fallback to
 * `reply` ever went away that message would render as a blank bubble - the
 * silent failure the whole path exists to replace, arrived at from the UI side.
 */
describe('extractReplies', () => {
  it('renders a terminal-recovery reply written next to an empty replies array', () => {
    // Exactly the shape the settle pass leaves behind on a dispatch-time quest.
    expect(extractReplies({ reply: ABANDONED_REPLY, replies: [] })).toEqual([ABANDONED_REPLY]);
  });

  it('prefers the streamed array once the server has written into it', () => {
    // A run that streamed and then had its status flipped: the real answer is in
    // `replies`, and a stale `reply` from an earlier settle must not win.
    expect(extractReplies({ reply: ABANDONED_REPLY, replies: ['the real answer'] })).toEqual(['the real answer']);
  });

  it('returns nothing when there is nothing to show', () => {
    expect(extractReplies({ replies: [] })).toEqual([]);
    expect(extractReplies({ reply: '', replies: [] })).toEqual([]);
    expect(extractReplies({ reply: '   ', replies: [] })).toEqual([]);
  });

  it('ignores an undefined replies array rather than throwing', () => {
    expect(extractReplies({ reply: ABANDONED_REPLY })).toEqual([ABANDONED_REPLY]);
  });
});

/**
 * The rule every session exporter reads a turn through. Exporters used to walk `replies`
 * directly behind an `if (reply)` truthiness guard, which a think-only slot passes - so a
 * tool-using turn wrote several blank "AI:" entries per turn and leaked raw `<think>`
 * markers into the downloaded file.
 */
describe('visibleReplyForExport', () => {
  it('collapses a tool-loop turn into the one string the bubble showed', () => {
    // The shape appendStreamedChunk leaves behind: a closed thinking block spills into its
    // own slot, and the next block reopens inside the slot holding the partial answer.
    expect(
      visibleReplyForExport({
        replies: ['<think>first reasoning</think>', 'PARTIAL ANSWER <think>second reasoning</think>FINAL ANSWER'],
      })
    ).toBe('PARTIAL ANSWER FINAL ANSWER');
  });

  it('returns nothing for a turn whose only slot is a thinking block', () => {
    expect(visibleReplyForExport({ replies: ['<think>reasoning that produced no answer</think>'] })).toBe('');
  });

  it('returns nothing rather than undefined when there is no reply at all', () => {
    expect(visibleReplyForExport({ replies: [] })).toBe('');
    expect(visibleReplyForExport({})).toBe('');
  });

  it('still surfaces a terminal-recovery reply written next to an empty replies array', () => {
    expect(visibleReplyForExport({ reply: ABANDONED_REPLY, replies: [] })).toBe(ABANDONED_REPLY);
  });
});

describe('extractThinking', () => {
  it('collects every thinking block in a slot, not just the first', () => {
    // A tool-using turn reopens its thinking inside the slot that already holds the partial
    // answer, so the second block sits mid-string with the answer either side of it.
    expect(extractThinking({ replies: ['<think>first</think>partial <think>second</think>final'] })).toBe(
      'first\n\nsecond'
    );
  });

  it('collects the reopened block from a two-slot accumulator sequence, not just the first slot', () => {
    // Matches the shape appendStreamedChunk leaves behind: the first thinking block spills
    // into its own slot once closed, and the second reopens inside the slot holding the
    // partial answer.
    expect(
      extractThinking({
        replies: ['<think>first reasoning</think>', 'PARTIAL ANSWER <think>second reasoning</think>FINAL ANSWER'],
      })
    ).toBe('first reasoning\n\nsecond reasoning');
  });

  it('takes a trailing block that has not closed yet', () => {
    expect(extractThinking({ replies: ['partial <think>still reasoning'] })).toBe('still reasoning');
  });

  it('returns nothing when no reply carries a thinking block', () => {
    expect(extractThinking({ replies: ['just an answer'] })).toBe('');
  });
});

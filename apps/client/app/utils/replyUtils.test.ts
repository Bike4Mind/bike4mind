import { describe, it, expect } from 'vitest';
import { extractReplies } from './replyUtils';
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

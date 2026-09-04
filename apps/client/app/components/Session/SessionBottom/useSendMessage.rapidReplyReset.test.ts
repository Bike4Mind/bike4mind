import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression guard: both chatCompletion resets must clear `rapidReply`.
 *
 * The rapid-reply bubble renders inside whichever message holds the streaming slot
 * (MessageContent, via ChatHistory). Nothing on the payload identifies its quest -
 * the wire carries a questId but it is absent on the ordinary composer send, so it
 * cannot be used to scope the bubble. Clearing the previous turn's acknowledgement
 * when a turn starts or is cancelled is therefore what keeps it from being drawn
 * under the wrong message: a stopped quest is never handed off, so it keeps the
 * streaming slot and a leftover rapidReply would render beneath it.
 *
 * Source-level assertion rather than renderHook, mirroring
 * useSendMessage.stopMessageToast.test.ts and useSendMessage.killSwitch.test.ts:
 * useSendMessage consumes ~15 context providers.
 */
describe('useSendMessage - rapidReply reset (regression)', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  it('clears rapidReply when a cancellation completes', () => {
    const handleStopMessage = source.match(/const handleStopMessage[\s\S]*?\n {2}\};/)?.[0] ?? '';
    expect(handleStopMessage).not.toBe('');

    const cancelledReset =
      handleStopMessage.match(
        /setChatCompletion\(prev => \(\{[\s\S]*?Generation cancelled by user[\s\S]*?\}\)\);/
      )?.[0] ?? '';
    expect(cancelledReset).not.toBe('');
    expect(cancelledReset).toMatch(/rapidReply: undefined/);
  });

  it('clears rapidReply when a new turn starts', () => {
    const sendReset =
      source.match(/setChatCompletion\(prev => \(\{[\s\S]*?OPTIMISTIC_GENERATING_STATUS,[\s\S]*?\}\)\);/)?.[0] ?? '';
    expect(sendReset).not.toBe('');
    expect(sendReset).toMatch(/rapidReply: undefined/);
  });
});

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
 *
 * MAINTENANCE CONTRACT: each assertion scopes to ONE reset via a unique anchor
 * (`isRealSlashCommand` for the send, `Generation cancelled by user` for the
 * cancel). Keeping the spans disjoint is the point - a span wide enough to contain
 * both resets passes while either one alone is broken. Update the anchors in the
 * same commit as any rename or extraction.
 */
describe('useSendMessage - rapidReply reset (regression)', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  // The send-time reset only: the `if (!isRealSlashCommand)` block and nothing after it.
  const sendReset =
    source.match(/if \(!isRealSlashCommand\) \{\s*setChatCompletion\(prev => \(\{[\s\S]*?\}\)\);\s*\}/)?.[0] ?? '';

  // The post-cancel reset only, anchored on its own status message.
  const cancelReset =
    source.match(/setChatCompletion\(prev => \(\{[^}]*?'Generation cancelled by user'[\s\S]*?\}\)\);/)?.[0] ?? '';

  it('scopes each assertion to a single reset', () => {
    expect(sendReset).not.toBe('');
    expect(cancelReset).not.toBe('');
    // Disjoint: neither span may contain the other's anchor, or a one-sided
    // regression would pass.
    expect(sendReset).not.toContain('Generation cancelled by user');
    expect(cancelReset).not.toContain('isRealSlashCommand');
    expect(sendReset).toContain('OPTIMISTIC_GENERATING_STATUS');
  });

  it('clears rapidReply when a new turn starts', () => {
    expect(sendReset).toMatch(/rapidReply: undefined/);
  });

  it('clears rapidReply when a cancellation completes', () => {
    expect(cancelReset).toMatch(/rapidReply: undefined/);
  });
});

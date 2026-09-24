import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The send-time Stop placeholder and its failure rollback must use the shared sentinel and
 * helper from chatCompletionState, whose behaviour through a first turn is tested in
 * useSubscribeChatCompletion.test.ts. Source-level, mirroring useSendMessage.rapidReplyReset.test.ts:
 * useSendMessage consumes ~15 context providers.
 */
describe('useSendMessage - optimistic Stop wiring', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  it('writes the shared sentinel as the send-time placeholder', () => {
    expect(source).toMatch(/statusMessage: OPTIMISTIC_GENERATING_STATUS,/);
    expect(source).not.toMatch(/const OPTIMISTIC_GENERATING_STATUS\b/);
  });

  it('rolls the placeholder back through the shared helper when the send throws', () => {
    const catchBlock = source.match(/data = await handler\(sessionToSend\);\s*\} catch[\s\S]*?return;\s*\}/)?.[0] ?? '';
    expect(catchBlock).not.toBe('');
    expect(catchBlock).toContain('setChatCompletion(rollbackOptimisticGenerating);');
  });
});

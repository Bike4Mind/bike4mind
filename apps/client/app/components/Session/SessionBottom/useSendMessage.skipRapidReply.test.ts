import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Wiring guard: `LLMCommand.rapidReply.test.ts` proves `skipRapidReply` suppresses the ack once
 * an arg sets it; this locks that a tool-directed send derives the flag and both dispatch sites
 * forward it. Source-level, matching `useSendMessage.skipAutoOffers.test.ts`.
 */
describe('useSendMessage - skipRapidReply reaches both dispatch paths', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  it('derives skipRapidReply from a non-empty toolsOverride', () => {
    expect(source).toMatch(/const skipRapidReply = \(options\?\.toolsOverride\?\.length \?\? 0\) > 0;/);
  });

  it.each([
    ['/llm command-map dispatch', 'return await handleCommand(commandHandlers,'],
    ['direct handleLLMCommand dispatch', 'return await handleLLMCommand({'],
  ])('forwards skipRapidReply on the %s', (_label, anchor) => {
    const handlerIdx = source.indexOf(anchor);
    expect(handlerIdx).toBeGreaterThan(-1);
    const callSite = source.slice(handlerIdx, source.indexOf('});', handlerIdx));
    expect(callSite).toMatch(/^\s*skipRapidReply,\s*$/m);
  });
});

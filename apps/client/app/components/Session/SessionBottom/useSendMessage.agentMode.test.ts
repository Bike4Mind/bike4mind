import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Ordinary composer turns go through the `/llm` entry of the command map (handleCommand), not
 * the direct handleLLMCommand call, so dropping `agentMode` there loses the routing provenance
 * on the main path. `LLMCommand.payload.test.ts` proves the field survives handleCommand onto
 * the wire; this locks that the hook actually hands it over on both dispatch sites.
 * Source-level for the same reason as `useSendMessage.skipAutoOffers.test.ts`.
 */
describe('useSendMessage - agentMode reaches both dispatch paths', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  const callSite = (opener: string) => {
    const start = source.indexOf(opener);
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('});', start));
  };

  it.each(['return await handleCommand(commandHandlers,', 'return await handleLLMCommand({'])(
    'forwards the routed effectiveAgentMode on %s',
    opener => {
      expect(callSite(opener)).toMatch(/^\s*agentMode: effectiveAgentMode,\s*$/m);
    }
  );
});

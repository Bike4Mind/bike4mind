import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Wiring guard for #2961. `LLMCommand.payload.test.ts` proves the wire body carries
 * `skipAutoOffers` once an arg sets it, and `ToolsSection.skipAutoOffers.test.tsx` proves
 * the toggle writes the right store key - neither would notice this hook reading the
 * store into a local it never forwards. A hard-coded `false` (or a dropped selector
 * entry) at either dispatch site ships a toggle that silently does nothing, same class
 * as the pre-existing `agentMode` gap this PR's own body calls out.
 *
 * Source-level assertions (not `renderHook`), matching the sibling
 * `useSendMessage.toolsOverride.test.ts`: the hook pulls in ~15 providers, so a full
 * render adds little over locking these invariants.
 */
describe('useSendMessage - skipAutoOffers reaches both dispatch paths (#2961)', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  it('reads skipAutoOffers out of the LLM store', () => {
    expect(source).toMatch(/s\.skipAutoOffers/);
  });

  it('passes skipAutoOffers into resolveTools so the Smart-mode recommender can honor it', () => {
    const resolveToolsCallIdx = source.indexOf('resolveTools({');
    expect(resolveToolsCallIdx).toBeGreaterThan(-1);
    const callSite = source.slice(resolveToolsCallIdx, source.indexOf('});', resolveToolsCallIdx));
    expect(callSite).toMatch(/\bskipAutoOffers\b/);
  });

  it('forwards skipAutoOffers on the /llm command-map dispatch (handleCommand)', () => {
    const handlerIdx = source.indexOf('return await handleCommand(commandHandlers,');
    expect(handlerIdx).toBeGreaterThan(-1);
    const callSite = source.slice(handlerIdx, source.indexOf('});', handlerIdx));
    expect(callSite).toMatch(/^\s*skipAutoOffers,\s*$/m);
  });

  it('forwards skipAutoOffers on the direct handleLLMCommand dispatch', () => {
    const handlerIdx = source.indexOf('return await handleLLMCommand({');
    expect(handlerIdx).toBeGreaterThan(-1);
    const callSite = source.slice(handlerIdx, source.indexOf('});', handlerIdx));
    expect(callSite).toMatch(/^\s*skipAutoOffers,\s*$/m);
  });
});

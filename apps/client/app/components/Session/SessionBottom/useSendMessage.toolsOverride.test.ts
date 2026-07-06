import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression guard for #95: when a briefcase prompt @-mentions an orchestration
 * agent, the agent-executor branch must still honor the briefcase `toolsOverride`
 * rather than dropping it for the agent's own `allowedTools`.
 *
 * Source-level assertions (not `renderHook`) match the sibling
 * `useSendMessage.hostCreate.test.ts`: the hook pulls in ~15 providers, so a
 * full render adds little over locking these invariants.
 */
describe('useSendMessage - briefcase toolsOverride on the orchestration path (#95)', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  it('threads the briefcase override into the agent-executor dispatch, else falls back to the agent whitelist', () => {
    expect(source).toMatch(
      /const enabledTools\s*=\s*options\?\.toolsOverride\s*\?\s*effectiveTools\s*:\s*orchestrationAgent\?\.allowedTools;/
    );
  });

  it('assigns enabledTools inside the agent-executor branch and passes it to agentExecution.start', () => {
    const branchIdx = source.indexOf("routeTarget === 'agent_executor'");
    const enabledToolsIdx = source.indexOf('const enabledTools =');
    const startIdx = source.indexOf('agentExecution.start(');
    expect(branchIdx).toBeGreaterThan(-1);
    expect(enabledToolsIdx).toBeGreaterThan(branchIdx);
    expect(startIdx).toBeGreaterThan(enabledToolsIdx);
    expect(source).toMatch(/agentExecution\.start\(\{[\s\S]*?\benabledTools\b[\s\S]*?\}\);/);
  });

  it('keeps the unsupported-tool refusal ahead of the orchestration branch (refusal still applies)', () => {
    // The refusal runs before routing, so the agent-executor branch needs none
    // of its own. This ordering is load-bearing.
    const refusedIdx = source.indexOf('if (refused)');
    const branchIdx = source.indexOf("routeTarget === 'agent_executor'");
    expect(refusedIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeGreaterThan(-1);
    expect(refusedIdx).toBeLessThan(branchIdx);
  });
});

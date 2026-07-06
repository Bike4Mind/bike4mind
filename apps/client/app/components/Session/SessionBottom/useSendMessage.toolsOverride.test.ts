import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression guard for #95: a briefcase launch pins the tools its prompt needs
 * via `toolsOverride`. When that prompt also @-mentions an orchestration agent,
 * `useSendMessage` routes the send through the agent-executor branch. That
 * branch must still honor the briefcase override rather than sourcing
 * `enabledTools` solely from the agent's `allowedTools` (which would drop the
 * briefcase's required tools and run the prompt without them).
 *
 * A source-level assertion is used (rather than a full `renderHook`) to match
 * the sibling `useSendMessage.hostCreate.test.ts` guard: `useSendMessage`
 * consumes ~15 context providers, so a full render adds little signal beyond
 * locking these invariants.
 */
describe('useSendMessage — briefcase toolsOverride on the orchestration path (#95)', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  it('threads the briefcase override into the agent-executor dispatch, else falls back to the agent whitelist', () => {
    // `enabledTools` prefers the resolved `effectiveTools` (the
    // BRIEFCASE_DISALLOWED-stripped override the normal path uses) when a
    // briefcase `toolsOverride` is present, and falls back to the orchestration
    // agent's own whitelist otherwise.
    expect(source).toMatch(
      /const enabledTools\s*=\s*options\?\.toolsOverride\s*\?\s*effectiveTools\s*:\s*orchestrationAgent\?\.allowedTools;/
    );
  });

  it('assigns enabledTools inside the agent-executor branch and passes it to agentExecution.start', () => {
    const branchIdx = source.indexOf("routeTarget === 'agent_executor'");
    const enabledToolsIdx = source.indexOf('const enabledTools =');
    const startIdx = source.indexOf('agentExecution.start(');
    expect(branchIdx).toBeGreaterThan(-1);
    // The whitelist is derived inside the branch and forwarded to the dispatch.
    expect(enabledToolsIdx).toBeGreaterThan(branchIdx);
    expect(startIdx).toBeGreaterThan(enabledToolsIdx);
    expect(source).toMatch(/agentExecution\.start\(\{[\s\S]*?\benabledTools\b[\s\S]*?\}\);/);
  });

  it('keeps the unsupported-tool refusal ahead of the orchestration branch (refusal still applies)', () => {
    // The refusal guard for a briefcase override on a tools-incapable model runs
    // unconditionally before routing, so the agent-executor branch never needs
    // its own refusal handling. This ordering is load-bearing.
    const refusedIdx = source.indexOf('if (refused)');
    const branchIdx = source.indexOf("routeTarget === 'agent_executor'");
    expect(refusedIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeGreaterThan(-1);
    expect(refusedIdx).toBeLessThan(branchIdx);
  });
});

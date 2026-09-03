import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Wiring guard for #95. The dispatch *behavior* is verified in
 * `resolveDispatchTools.test.ts`; this locks that the hook actually uses that
 * decision for the agent-executor dispatch, and that the unsupported-tool
 * refusal still runs first.
 *
 * Source-level assertions (not `renderHook`) match the sibling
 * `useSendMessage.hostCreate.test.ts`: the hook pulls in ~15 providers, so a
 * full render adds little over locking these invariants.
 */
describe('useSendMessage - briefcase toolsOverride on the orchestration path (#95)', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  it('derives enabledTools from resolveDispatchTools(toolsOverride, effectiveTools, agent whitelist, org defaults)', () => {
    expect(source).toMatch(
      /const enabledTools\s*=\s*resolveDispatchTools\(\s*options\?\.toolsOverride,\s*effectiveTools,\s*orchestrationAgent\?\.allowedTools,\s*agentModeDefaultTools\s*\);/
    );
  });

  it('sources the agentless union base from admin settings, not a hardcoded seed', () => {
    // The server REPLACES `profile.allowedTools` with a non-empty payload, so
    // unioning a hardcoded schema seed here would override an admin who
    // narrowed the org toolbelt. This is the wiring that stops that.
    expect(source).toMatch(/agentModeDefaultToolNames\(orchestrationDefaultsSetting\)/);
    expect(source).toMatch(/getSettingObject<unknown>\('orchestrationDefaults', undefined\)/);
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

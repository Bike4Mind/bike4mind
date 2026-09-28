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

  it('derives the dispatch tool selection from resolveDispatchTools(toolsOverride, effectiveTools, agent whitelist)', () => {
    expect(source).toMatch(
      /const \{ enabledTools, enabledToolsAreAmbient \} = resolveDispatchTools\(\s*options\?\.toolsOverride,\s*effectiveTools,\s*orchestrationAgent\?\.allowedTools\s*\);/
    );
  });

  it('puts NO derived copy of admin config on the wire', () => {
    // The union of the user's picks and the org toolbelt happens server-side, in
    // `pickEffectiveEnabledTools`, against the profile the executor just resolved. The hook
    // used to read `orchestrationDefaults` to build that union here, which shipped a
    // client-derived copy of admin config that could drift from what the server resolves -
    // and made the client guess at org policy (unreadable setting, emptied `allowedTools`) to
    // decide whether its own copy was safe to send. Neither symbol may come back.
    expect(source).not.toMatch(/agentModeDefaultToolNames/);
    expect(source).not.toMatch(/agentModeDefaultTools/);
  });

  it('forwards the ambient marker alongside enabledTools', () => {
    // Without it the server cannot tell the user's ambient composer picks from a pinned
    // selection, so it would REPLACE the org's agent-mode toolbelt with the picks - stripping
    // `web_search` / `recharts` / `mermaid_chart` from every agentless run.
    expect(source).toMatch(/agentExecution\.start\(\{[\s\S]*?\benabledToolsAreAmbient\b[\s\S]*?\}\);/);
  });

  it('withholds the intent-classifier admin gate until the AUTHED settings fetch has landed', () => {
    // `orchestrationDefaults` is not `publicSafe`, yet `mergeIntoDefaults` seeds it with the
    // compiled-in schema default for the public query too - so it reads
    // `intentClassifier.enabled: true` before the authed fetch resolves, and an org that
    // explicitly disabled the classifier would still have it running during that window.
    expect(source).toMatch(/const intentClassifierAdminEnabled =\s*authedSettingsLoaded\s*&&\s*getSettingObject/);
  });

  it('assigns enabledTools inside the agent-executor branch and passes it to agentExecution.start', () => {
    const branchIdx = source.indexOf("routeTarget === 'agent_executor'");
    const enabledToolsIdx = source.indexOf('const { enabledTools, enabledToolsAreAmbient } =');
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

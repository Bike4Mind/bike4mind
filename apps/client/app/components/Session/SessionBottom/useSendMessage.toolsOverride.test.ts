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
      /const \{ enabledTools, enabledToolsAreAmbient \} = resolveDispatchTools\(\s*options\?\.toolsOverride,\s*effectiveTools,\s*dispatchAgent\?\.allowedTools\s*\);/
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

/**
 * Per-send system context (a programmatic launch's `systemContext`). Same source-level approach
 * as above. The behaviour on each wire is covered where it is built: `LLMCommand.payload.test.ts`
 * (chat route) and `agentExecute.test.ts` / `startAgentExecution.test.ts` (agent route).
 */
describe('useSendMessage - per-send systemContext reaches both routes', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  // One call, from its opener to the first `});` after it. Bounding the slice is the point: an
  // unbounded lazy regex would let a call missing its spread match on the NEXT call's spread.
  const callSlice = (opener: string): string => {
    const start = source.indexOf(opener);
    expect(start, `${opener} not found in useSendMessage.ts`).toBeGreaterThan(-1);
    const end = source.indexOf('});', start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };

  it('resolves it once via resolveSystemContext and builds the field only when set', () => {
    expect(source).toMatch(/const resolvedSystemContext = resolveSystemContext\(options\?\.systemContext\);/);
    expect(source).toMatch(/const systemContextField = systemContext \? \{ systemContext \} : \{\};/);
  });

  it('refuses an over-cap value through onRefused before any dispatch', () => {
    const refusalStart = source.indexOf("if (resolvedSystemContext.kind === 'tooLong')");
    expect(refusalStart).toBeGreaterThan(-1);
    const refusal = source.slice(refusalStart, source.indexOf('return;', refusalStart));
    expect(refusal).toContain('setSubmitting(false);');
    expect(refusal).toContain('options?.onRefused?.();');
    expect(refusalStart).toBeLessThan(source.indexOf('handleCommand(commandHandlers, {'));
  });

  it.each(['handleCommand(commandHandlers, {', 'handleLLMCommand({', 'agentExecution.start({'])(
    'spreads it into %s',
    opener => {
      expect(callSlice(opener)).toContain('...systemContextField,');
    }
  );

  it('never folds it into the prompt text the bubble shows', () => {
    expect(source).not.toMatch(/prompt\s*[+=].*systemContext/);
  });
});

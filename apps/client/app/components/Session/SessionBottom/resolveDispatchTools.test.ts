import { describe, it, expect } from 'vitest';
import type { B4MLLMTools } from '@bike4mind/common';
import { resolveDispatchTools } from './resolveDispatchTools';

/**
 * Before/after regression for #95. Drives the real dispatch decision the hook
 * uses, comparing it against the pre-fix behavior (the agent-executor branch
 * always used the agent's own whitelist, ignoring the briefcase override).
 */

// Pre-fix behavior: `const enabledTools = orchestrationAgent?.allowedTools`.
const beforeFix = (
  _toolsOverride: B4MLLMTools[] | undefined,
  _effectiveTools: B4MLLMTools[],
  agentAllowedTools: string[] | undefined
): string[] | undefined => agentAllowedTools;

interface Scenario {
  name: string;
  toolsOverride: B4MLLMTools[] | undefined;
  effectiveTools: B4MLLMTools[];
  agentAllowedTools: string[] | undefined;
  expected: string[] | undefined;
  expectedAmbient: boolean;
  changedByFix: boolean;
}

const scenarios: Scenario[] = [
  {
    name: 'briefcase override + @mentioned agent',
    toolsOverride: ['web_search'],
    effectiveTools: ['web_search'],
    agentAllowedTools: ['mermaid_chart'],
    expected: ['web_search'], // the bug: was ['mermaid_chart']
    expectedAmbient: false,
    changedByFix: true,
  },
  {
    name: 'no override, @mentioned agent (unchanged)',
    toolsOverride: undefined,
    effectiveTools: [],
    agentAllowedTools: ['mermaid_chart'],
    expected: ['mermaid_chart'],
    expectedAmbient: false,
    changedByFix: false,
  },
  {
    name: 'no override, agentless with no picks (unchanged, synthetic profile)',
    toolsOverride: undefined,
    effectiveTools: [],
    agentAllowedTools: undefined,
    expected: undefined,
    expectedAmbient: false,
    changedByFix: false,
  },
  {
    name: 'empty override is not a real override (unchanged)',
    toolsOverride: [],
    effectiveTools: ['recharts'],
    agentAllowedTools: ['mermaid_chart'],
    expected: ['mermaid_chart'],
    expectedAmbient: false,
    changedByFix: false,
  },
  {
    name: 'a mentioned agent whitelist still beats the ambient Smart Tools (unchanged)',
    toolsOverride: undefined,
    effectiveTools: ['deep_research'],
    agentAllowedTools: ['mermaid_chart'],
    expected: ['mermaid_chart'],
    expectedAmbient: false,
    changedByFix: false,
  },
  {
    name: 'briefcase override still beats the agentless ambient picks',
    toolsOverride: ['web_search'],
    effectiveTools: ['web_search'],
    agentAllowedTools: undefined,
    expected: ['web_search'],
    expectedAmbient: false,
    changedByFix: true,
  },
];

describe('resolveDispatchTools (#95 before/after regression)', () => {
  it('prints the before/after table', () => {
    const rows = scenarios.map(s => {
      const before = beforeFix(s.toolsOverride, s.effectiveTools, s.agentAllowedTools);
      const after = resolveDispatchTools(s.toolsOverride, s.effectiveTools, s.agentAllowedTools);
      return {
        scenario: s.name,
        before: JSON.stringify(before),
        after: JSON.stringify(after.enabledTools),
        ambient: after.enabledToolsAreAmbient,
        changed: JSON.stringify(before) !== JSON.stringify(after.enabledTools),
      };
    });
    console.table(rows);
    expect(rows).toHaveLength(scenarios.length);
  });

  it.each(scenarios)('$name', s => {
    const after = resolveDispatchTools(s.toolsOverride, s.effectiveTools, s.agentAllowedTools);
    // New behavior matches expectation.
    expect(after.enabledTools).toEqual(s.expected);
    expect(after.enabledToolsAreAmbient).toBe(s.expectedAmbient);
    // Only the bug scenario changes vs the pre-fix behavior; everything else holds.
    const before = beforeFix(s.toolsOverride, s.effectiveTools, s.agentAllowedTools);
    expect(JSON.stringify(before) !== JSON.stringify(after.enabledTools)).toBe(s.changedByFix);
  });
});

describe('resolveDispatchTools agentless dispatch', () => {
  // The reported bug: with no agent mentioned, `enabledTools` went out `undefined`, so the
  // server fell back to the fixed synthetic toolset and the user's Smart Tools silently
  // vanished. The picks now go out marked AMBIENT, and the executor unions them onto the
  // profile it resolves - so the picks survive AND the agent keeps its own core tools, which
  // a bare pinned payload would have stripped (buildSharedTools only surfaces named tools).
  const SMART_TOOLS: B4MLLMTools[] = ['deep_research', 'chess_engine', 'web_scrape'];

  // The empty-whitelist case also covers an `@`-mention of an agent that curated no tools: the
  // payload carries `agentId` AND the ambient flag, so the server lands on a persisted profile
  // whose belt came from admin defaults. That the org toolbelt survives there is asserted in
  // `agentExecutor.orchestrationProfile.test.ts` ('keeps the org toolbelt for an @-mention...'),
  // since the union is the server's job now and this side only proves what goes on the wire.
  it.each([
    ['no agent mentioned', undefined],
    ['an agent whose whitelist is empty', [] as string[]],
  ])('sends the user Smart Tools marked ambient when there is %s', (_label, agentAllowedTools) => {
    const result = resolveDispatchTools(undefined, SMART_TOOLS, agentAllowedTools);
    expect(result.enabledTools).toEqual(SMART_TOOLS);
    expect(result.enabledToolsAreAmbient).toBe(true);
  });

  it('sends exactly the picks - no derived org toolbelt rides along', () => {
    // The whole point of moving the union server-side: this payload is only ever what the
    // user actually selected, so there is no client-side copy of admin config on the wire
    // that could drift from what the executor resolves.
    const result = resolveDispatchTools(undefined, SMART_TOOLS, undefined);
    expect(new Set(result.enabledTools)).toEqual(new Set(SMART_TOOLS));
    for (const orgTool of ['web_search', 'retrieve_knowledge_content', 'recharts', 'mermaid_chart']) {
      expect(result.enabledTools).not.toContain(orgTool);
    }
  });

  it('sends nothing when no Smart Tool is selected, so the server resolves the profile', () => {
    // Nothing to preserve, so don't ship an empty array the server reads as "use the profile".
    expect(resolveDispatchTools(undefined, [], undefined)).toEqual({
      enabledTools: undefined,
      enabledToolsAreAmbient: false,
    });
  });

  it('never marks a pinned selection as ambient', () => {
    // Load-bearing: ambient means "union me onto the profile". A briefcase override or a
    // mentioned agent's whitelist must keep REPLACING the profile toolbelt, so mislabelling
    // one would silently re-broaden a deliberately scoped run.
    expect(resolveDispatchTools(['web_search'], ['web_search'], undefined).enabledToolsAreAmbient).toBe(false);
    expect(resolveDispatchTools(undefined, SMART_TOOLS, ['mermaid_chart']).enabledToolsAreAmbient).toBe(false);
  });
});

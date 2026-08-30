import { describe, it, expect } from 'vitest';
import type { B4MLLMTools } from '@bike4mind/common';
import { agentModeDefaultToolNames } from '@client/app/utils/agentOrchestration';
import { resolveDispatchTools } from './resolveDispatchTools';

// The org's agent-mode toolbelt. Sourced from admin settings in the hook; the
// schema seed (no admin override) is the representative case here.
const DEFAULT_TOOLS = agentModeDefaultToolNames(undefined);

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
  changedByFix: boolean;
}

const scenarios: Scenario[] = [
  {
    name: 'briefcase override + @mentioned agent',
    toolsOverride: ['web_search'],
    effectiveTools: ['web_search'],
    agentAllowedTools: ['mermaid_chart'],
    expected: ['web_search'], // the bug: was ['mermaid_chart']
    changedByFix: true,
  },
  {
    name: 'no override, @mentioned agent (unchanged)',
    toolsOverride: undefined,
    effectiveTools: [],
    agentAllowedTools: ['mermaid_chart'],
    expected: ['mermaid_chart'],
    changedByFix: false,
  },
  {
    name: 'no override, agentless (unchanged, synthetic profile)',
    toolsOverride: undefined,
    effectiveTools: [],
    agentAllowedTools: undefined,
    expected: undefined,
    changedByFix: false,
  },
  {
    name: 'empty override is not a real override (unchanged)',
    toolsOverride: [],
    effectiveTools: ['recharts'],
    agentAllowedTools: ['mermaid_chart'],
    expected: ['mermaid_chart'],
    changedByFix: false,
  },
  {
    name: 'a mentioned agent whitelist still beats the ambient Smart Tools (unchanged)',
    toolsOverride: undefined,
    effectiveTools: ['deep_research'],
    agentAllowedTools: ['mermaid_chart'],
    expected: ['mermaid_chart'],
    changedByFix: false,
  },
  {
    name: 'briefcase override still beats the agentless union',
    toolsOverride: ['web_search'],
    effectiveTools: ['web_search'],
    agentAllowedTools: undefined,
    expected: ['web_search'],
    changedByFix: true,
  },
];

describe('resolveDispatchTools (#95 before/after regression)', () => {
  it('prints the before/after table', () => {
    const rows = scenarios.map(s => {
      const before = beforeFix(s.toolsOverride, s.effectiveTools, s.agentAllowedTools);
      const after = resolveDispatchTools(s.toolsOverride, s.effectiveTools, s.agentAllowedTools, DEFAULT_TOOLS);
      return {
        scenario: s.name,
        before: JSON.stringify(before),
        after: JSON.stringify(after),
        changed: JSON.stringify(before) !== JSON.stringify(after),
      };
    });
    console.table(rows);
    expect(rows).toHaveLength(scenarios.length);
  });

  it.each(scenarios)('$name', s => {
    const after = resolveDispatchTools(s.toolsOverride, s.effectiveTools, s.agentAllowedTools, DEFAULT_TOOLS);
    // New behavior matches expectation.
    expect(after).toEqual(s.expected);
    // Only the bug scenario changes vs the pre-fix behavior; everything else holds.
    const before = beforeFix(s.toolsOverride, s.effectiveTools, s.agentAllowedTools);
    expect(JSON.stringify(before) !== JSON.stringify(after)).toBe(s.changedByFix);
  });
});

describe('resolveDispatchTools agentless dispatch', () => {
  // The reported bug: with no agent mentioned, `enabledTools` went out
  // `undefined`, so the server fell back to the fixed synthetic toolset and the
  // user's Smart Tools silently vanished. It now sends the union - the picks
  // survive AND the agent keeps its own core tools, which a bare Smart Tools
  // payload would have stripped (buildSharedTools only surfaces named tools).
  const SMART_TOOLS: B4MLLMTools[] = ['deep_research', 'chess_engine', 'web_scrape'];

  it.each([
    ['no agent mentioned', undefined],
    ['an agent whose whitelist is empty', [] as string[]],
  ])('unions the user Smart Tools with the agent-mode defaults when there is %s', (_label, agentAllowedTools) => {
    const result = resolveDispatchTools(undefined, SMART_TOOLS, agentAllowedTools, DEFAULT_TOOLS);
    expect(result).toBeDefined();
    // The user's picks reach the run - none of these are in the default toolbelt.
    for (const tool of SMART_TOOLS) expect(result).toContain(tool);
    // ...and the default toolbelt survives it. These are the ones actually
    // gated by `enabledTools` in `buildSharedTools`; `file_read` / `code_execute`
    // / `coordinate_task` also ride along from the schema list but are inert on
    // this path, so they are not what makes the union load-bearing.
    for (const tool of ['web_search', 'retrieve_knowledge_content', 'recharts', 'mermaid_chart']) {
      expect(result).toContain(tool);
    }
    expect(result).toEqual([...new Set(result)]);
  });

  it('is exactly the union, with nothing invented beyond it', () => {
    const result = resolveDispatchTools(undefined, SMART_TOOLS, undefined, DEFAULT_TOOLS);
    expect(new Set(result)).toEqual(new Set([...SMART_TOOLS, ...DEFAULT_TOOLS]));
  });

  it('sends nothing when no Smart Tool is selected, so the server resolves the profile', () => {
    // Nothing to preserve here, so leave the whole decision server-side rather
    // than round-tripping the client's view of the org toolbelt.
    expect(resolveDispatchTools(undefined, [], undefined, DEFAULT_TOOLS)).toBeUndefined();
  });

  it('never widens past the org toolbelt it is handed', () => {
    // The server REPLACES `profile.allowedTools` with a non-empty payload, so
    // an admin-narrowed toolbelt must not be re-broadened by the union.
    const narrowed = agentModeDefaultToolNames({ allowedTools: ['web_search'] });
    const result = resolveDispatchTools(undefined, ['deep_research'], undefined, narrowed);
    expect(new Set(result)).toEqual(new Set(['deep_research', 'web_search']));
    expect(result).not.toContain('image_generation');
  });
});

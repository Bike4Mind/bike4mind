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
];

describe('resolveDispatchTools (#95 before/after regression)', () => {
  it('prints the before/after table', () => {
    const rows = scenarios.map(s => {
      const before = beforeFix(s.toolsOverride, s.effectiveTools, s.agentAllowedTools);
      const after = resolveDispatchTools(s.toolsOverride, s.effectiveTools, s.agentAllowedTools);
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
    const after = resolveDispatchTools(s.toolsOverride, s.effectiveTools, s.agentAllowedTools);
    // New behavior matches expectation.
    expect(after).toEqual(s.expected);
    // Only the bug scenario changes vs the pre-fix behavior; everything else holds.
    const before = beforeFix(s.toolsOverride, s.effectiveTools, s.agentAllowedTools);
    expect(JSON.stringify(before) !== JSON.stringify(after)).toBe(s.changedByFix);
  });
});

import { describe, it, expect } from 'vitest';
import type { IAgent } from '@bike4mind/common';
import { pickRoutingSource } from './pickRoutingSource';

/**
 * Precedence coverage for pickRoutingSource. The visible behavior (badge
 * + Tools-panel gating) is covered elsewhere; this locks the pure precedence
 * ordering so a future auto-route source can't silently reorder it.
 */

// Minimal IAgent stand-in; only identity (truthiness) matters to pickRoutingSource.
const AGENT = { id: 'a1' } as unknown as IAgent;

// All routing signals off; override per-test.
const base = {
  routeTarget: 'agent_executor' as const,
  orchestrationAgent: null as IAgent | null,
  promptHasAgentLiteral: false,
  agentToggleActive: false,
  classifierUpgraded: false,
  agentDefaultOn: false,
  complexityUpgraded: false,
};

describe('pickRoutingSource', () => {
  it('returns undefined when the route stays on quest_processor (even if signals are set)', () => {
    expect(
      pickRoutingSource({ ...base, routeTarget: 'quest_processor', agentToggleActive: true, complexityUpgraded: true })
    ).toBeUndefined();
  });

  it('returns undefined on agent_executor when no signal matches', () => {
    expect(pickRoutingSource(base)).toBeUndefined();
  });

  it('maps each signal to its source when it is the only one set', () => {
    expect(pickRoutingSource({ ...base, orchestrationAgent: AGENT })).toBe('mention');
    expect(pickRoutingSource({ ...base, promptHasAgentLiteral: true })).toBe('agent_literal');
    expect(pickRoutingSource({ ...base, agentToggleActive: true })).toBe('toggle');
    expect(pickRoutingSource({ ...base, classifierUpgraded: true })).toBe('classifier');
    expect(pickRoutingSource({ ...base, agentDefaultOn: true })).toBe('user-default');
    expect(pickRoutingSource({ ...base, complexityUpgraded: true })).toBe('complexity');
  });

  it('applies the full precedence order when several signals are set at once', () => {
    // Everything on -> mention wins (highest precedence).
    const all = {
      ...base,
      orchestrationAgent: AGENT,
      promptHasAgentLiteral: true,
      agentToggleActive: true,
      classifierUpgraded: true,
      agentDefaultOn: true,
      complexityUpgraded: true,
    };
    expect(pickRoutingSource(all)).toBe('mention');
    expect(pickRoutingSource({ ...all, orchestrationAgent: null })).toBe('agent_literal');
    expect(pickRoutingSource({ ...all, orchestrationAgent: null, promptHasAgentLiteral: false })).toBe('toggle');
    expect(
      pickRoutingSource({ ...all, orchestrationAgent: null, promptHasAgentLiteral: false, agentToggleActive: false })
    ).toBe('classifier');
    expect(
      pickRoutingSource({
        ...all,
        orchestrationAgent: null,
        promptHasAgentLiteral: false,
        agentToggleActive: false,
        classifierUpgraded: false,
      })
    ).toBe('user-default');
  });

  it('complexity wins only when every higher-precedence signal misses', () => {
    // complexity + user-default both on -> user-default wins (complexity is lowest).
    expect(pickRoutingSource({ ...base, agentDefaultOn: true, complexityUpgraded: true })).toBe('user-default');
    // complexity alone -> complexity.
    expect(pickRoutingSource({ ...base, complexityUpgraded: true })).toBe('complexity');
  });
});

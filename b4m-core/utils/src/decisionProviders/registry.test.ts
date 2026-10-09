import { describe, expect, it } from 'vitest';
import { OpenAiDecisionProvider } from './openaiDecisions/OpenAiDecisionProvider';
import { createDecisionProviderRegistry } from './registry';
import { TestDecisionProvider } from './test/TestDecisionProvider';
import type { DecisionProvider } from './types';

describe('createDecisionProviderRegistry', () => {
  it('routes each catalog model to the adapter for its protocol', () => {
    const registry = createDecisionProviderRegistry([new TestDecisionProvider(), new OpenAiDecisionProvider()]);
    expect(registry.forModel('gpt-6-luna')?.id).toBe('openaiDecisions');
    expect(registry.forModel('test-decisions')?.id).toBe('test');
  });

  it('leaves a model unserved when its adapter is not registered', () => {
    expect(createDecisionProviderRegistry([new OpenAiDecisionProvider()]).forModel('test-decisions')).toBeUndefined();
  });

  it('rejects a duplicate adapter', () => {
    expect(() => createDecisionProviderRegistry([new OpenAiDecisionProvider(), new OpenAiDecisionProvider()])).toThrow(
      /duplicate/
    );
  });

  it('rejects an adapter that claims a model the catalog assigns elsewhere, or drops one of its own', () => {
    const claimsOther: DecisionProvider = {
      id: 'test',
      models: ['test-decisions', 'gpt-6-luna'],
      decide: async () => ({}) as never,
    };
    const dropsOwn: DecisionProvider = { id: 'openaiDecisions', models: [], decide: async () => ({}) as never };
    expect(() => createDecisionProviderRegistry([claimsOther])).toThrow(/catalog assigns/);
    expect(() => createDecisionProviderRegistry([dropsOwn])).toThrow(/does not list/);
  });
});

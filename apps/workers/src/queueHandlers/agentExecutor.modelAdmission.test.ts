import { describe, expect, it, vi } from 'vitest';
import type { ServerAgentDefinition } from '@bike4mind/services/llm';
import { admitAgentDefinitions } from './agentExecutor.modelAdmission';

const def = (model: string, fallbackModels?: string[]) =>
  ({ name: model, model, fallbackModels }) as ServerAgentDefinition;
const admission = { admits: async (id: string) => !id.startsWith('gated') };

describe('admitAgentDefinitions', () => {
  it('keeps an agent whose models are all admitted unchanged', async () => {
    expect(await admitAgentDefinitions([def('a', ['b'])], admission)).toEqual([def('a', ['b'])]);
  });

  it('promotes the first admitted fallback when the preferred model is not admitted', async () => {
    const [agent] = await admitAgentDefinitions([def('gated-x', ['gated-y', 'b', 'c'])], admission);
    expect(agent.model).toBe('b');
    expect(agent.fallbackModels).toEqual(['c']);
  });

  it('drops an agent with no admitted model', async () => {
    expect(await admitAgentDefinitions([def('gated-x', ['gated-y']), def('gated-z')], admission)).toEqual([]);
  });

  it.each([
    ['claude-sonnet-4-6', true],
    ['claude-sonnet-4-6', false],
    ['claude-3-5-sonnet-20241022', true],
    ['claude-3-5-sonnet-20241022', false],
  ])('checks canonical admission for %s when admitted is %s', async (model, allowed) => {
    const admits = vi.fn(async () => allowed);

    const result = await admitAgentDefinitions([def(model)], { admits });

    expect(admits).toHaveBeenCalledExactlyOnceWith('claude-sonnet-4-6');
    expect(result.map(agent => agent.model)).toEqual(allowed ? ['claude-sonnet-4-6'] : []);
  });

  it('promotes an allowed fallback when a retired preferred model resolves to a gated successor', async () => {
    const admits = vi.fn(async (model: string) => model !== 'claude-sonnet-4-6');

    const [agent] = await admitAgentDefinitions(
      [def('claude-3-5-sonnet-20241022', ['gpt-4o', 'claude-3-7-sonnet-20250219'])],
      { admits }
    );

    expect(agent.model).toBe('gpt-4o');
    expect(agent.fallbackModels).toEqual([]);
    expect(admits.mock.calls.map(([model]) => model)).toEqual(['claude-sonnet-4-6', 'gpt-4o', 'claude-sonnet-4-6']);
  });

  it('canonicalizes an allowed retired fallback after dropping the gated preferred model', async () => {
    const [agent] = await admitAgentDefinitions([def('gated-model', ['claude-3-5-sonnet-20241022'])], admission);

    expect(agent.model).toBe('claude-sonnet-4-6');
    expect(agent.fallbackModels).toEqual([]);
  });
});

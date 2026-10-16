import { describe, expect, it } from 'vitest';
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
});

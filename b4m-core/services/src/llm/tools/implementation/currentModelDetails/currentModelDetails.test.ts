import { describe, expect, it, vi } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import type { ToolContext } from '../../base/types';
import { currentModelDetailsTool } from './index';

const model = (id: string, backend: ModelBackend, extra: Partial<ModelInfo> = {}) =>
  ({
    id,
    type: 'text',
    name: `Name of ${id}`,
    backend,
    contextWindow: 200_000,
    max_tokens: 8_000,
    can_stream: true,
    supportsTools: true,
    supportsVision: true,
    supportsImageVariation: false,
    pricing: { 200000: { input: 3e-6, output: 15e-6 } },
    ...extra,
  }) as unknown as ModelInfo;

const call = async (context: Partial<ToolContext>) => {
  const tool = currentModelDetailsTool.implementation(context as ToolContext);
  return tool.toolFn({});
};

describe('current_model_details', () => {
  it('reads the serving model at call time, not at build time', async () => {
    const servingModel = { current: model('model-a', ModelBackend.OpenAI) };
    const tool = currentModelDetailsTool.implementation({ servingModel } as ToolContext);

    expect(JSON.parse((await tool.toolFn({})) as string).id).toBe('model-a');
    servingModel.current = model('model-b', ModelBackend.Anthropic);
    expect(JSON.parse((await tool.toolFn({})) as string).id).toBe('model-b');
  });

  it('returns registry fields and never pricing', async () => {
    const out = (await call({
      servingModel: { current: model('m', ModelBackend.Anthropic, { can_think: true, thinkingStyle: 'adaptive' }) },
    })) as string;
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      name: 'Name of m',
      id: 'm',
      backend: 'anthropic',
      contextWindow: 200_000,
      maxTokens: 8_000,
      capabilities: {
        supportsTools: true,
        supportsVision: true,
        canStream: true,
        canThink: true,
        thinkingStyle: 'adaptive',
      },
    });
    expect(out).not.toMatch(/pricing|cost|input"|output"/i);
  });

  it('omits a derived output cap and a thinking style the registry never set', async () => {
    const out = (await call({
      servingModel: {
        current: model('g', ModelBackend.Gemini, { can_think: true, maxOutputTokensDerived: true }),
      },
    })) as string;
    const parsed = JSON.parse(out);

    expect(parsed).not.toHaveProperty('maxTokens');
    expect(parsed.capabilities).toMatchObject({ canThink: true });
    expect(parsed.capabilities).not.toHaveProperty('thinkingStyle');
  });

  it.each([
    [ModelBackend.Bedrock, 'AWS Bedrock'],
    [ModelBackend.Anthropic, 'direct Anthropic API'],
    [ModelBackend.Ollama, 'local Ollama'],
    [ModelBackend.OpenAI, 'openai'],
  ])('labels the %s backend', async (backend, label) => {
    const out = (await call({ servingModel: { current: model('m', backend) } })) as string;
    expect(JSON.parse(out).servedVia).toBe(label);
  });

  it('falls back to availableModels/model without a reference, and says so when nothing resolves', async () => {
    const out = await call({
      availableModels: [model('x', ModelBackend.OpenAI)],
      model: 'x',
      logger: { log: vi.fn() } as never,
    });
    expect(JSON.parse(out as string).id).toBe('x');
    await expect(call({})).resolves.toMatch(/unavailable/);
  });
});

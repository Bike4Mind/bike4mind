import { describe, expect, it } from 'vitest';
import { ModelBackend, isModelDeprecated, type ModelInfo } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import AnthropicBedrockBackend from './bedrockBackend/anthropic';
import { alignRouteTwinNames, directTwinId } from './routeTwinNames';

const model = (id: string, backend: ModelBackend, name: string): ModelInfo =>
  ({ id, backend, name, type: 'text' }) as ModelInfo;

describe('directTwinId', () => {
  it.each([
    ['global.anthropic.claude-haiku-5-5', 'claude-haiku-5-5'],
    ['anthropic.claude-haiku-5-5', 'claude-haiku-5-5'],
    ['us.anthropic.claude-3-5-sonnet-20241022-v2:0', 'claude-3-5-sonnet-20241022'],
    ['global.anthropic.claude-opus-4-6-v1', 'claude-opus-4-6'],
  ])('maps %s to %s', (id, expected) => {
    expect(directTwinId({ id, backend: ModelBackend.Bedrock })).toBe(expected);
  });

  it('is null off Bedrock', () => {
    expect(directTwinId({ id: 'claude-haiku-5-5', backend: ModelBackend.Anthropic })).toBeNull();
  });
});

describe('alignRouteTwinNames', () => {
  it('renames a Bedrock route after its listed direct twin', async () => {
    const result = await alignRouteTwinNames([
      model('claude-haiku-5-5', ModelBackend.Anthropic, 'Claude Haiku 5.5'),
      model('global.anthropic.claude-haiku-5-5', ModelBackend.Bedrock, 'Claude 5.5 Haiku'),
      model('anthropic.claude-haiku-5-5', ModelBackend.Bedrock, 'Claude 5.5 Haiku'),
    ]);
    expect(result.map(m => m.name)).toEqual(['Claude Haiku 5.5', 'Claude Haiku 5.5', 'Claude Haiku 5.5']);
  });

  it('falls back to the adapter literal when the caller lists no direct twin', async () => {
    const [aligned] = await alignRouteTwinNames([
      model('global.anthropic.claude-haiku-5-5', ModelBackend.Bedrock, 'Claude 5.5 Haiku'),
    ]);
    expect(aligned.name).toBe('Claude Haiku 5.5');
  });

  it('leaves a Bedrock model with no direct twin, and other backends, untouched', async () => {
    const input = [
      model('meta.llama4-scout-17b-instruct-v1:0', ModelBackend.Bedrock, 'Llama 4 Scout'),
      model('gpt-4.1', ModelBackend.OpenAI, 'GPT-4.1'),
    ];
    const result = await alignRouteTwinNames(input);
    expect(result[0]).toBe(input[0]);
    expect(result[1]).toBe(input[1]);
  });

  // Guards the two adapter tables against drifting apart again: every listed Bedrock Claude with a
  // direct literal must already carry that literal's name, so alignment is a no-op on seeds.
  // Deprecated rows are never listed, so their legacy names are left alone.
  it('finds every listed Bedrock Claude already named like its direct literal', async () => {
    const direct = new Map(
      (await new AnthropicBackend('static-listing').getModelInfo()).map(m => [String(m.id), m.name])
    );
    const bedrock = (await new AnthropicBedrockBackend().getModelInfo()).filter(m => !isModelDeprecated(m));
    const mismatched = bedrock.flatMap(m => {
      const twin = direct.get(directTwinId(m) ?? '');
      return twin && twin !== m.name ? [`${m.id}: ${m.name} vs ${twin}`] : [];
    });
    expect(mismatched).toEqual([]);
  });
});

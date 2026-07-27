import { describe, expect, it } from 'vitest';
import { ADAPTER_FAMILIES, ModelBackend } from '@bike4mind/common';
import { DISPATCHABLE_ADAPTER_FAMILIES } from './mergeCatalog';
import { resolveDispatchForRecord } from './dispatchResolver';

const resolve = (id: string, backend: ModelBackend) => resolveDispatchForRecord({ id, backend });

describe('resolveDispatchForRecord: Bedrock prefix map (sec 5.4)', () => {
  it.each([
    ['anthropic.claude-3-haiku-20240307-v1:0', 'bedrock-anthropic'],
    ['us.anthropic.claude-sonnet-9-20260101-v1:0', 'bedrock-anthropic'],
    ['global.anthropic.claude-opus-9', 'bedrock-anthropic'],
    ['eu.anthropic.claude-sonnet-9', 'bedrock-anthropic'],
    ['meta.llama5-8b-instruct-v1:0', 'bedrock-llama'],
    ['us.meta.llama5-maverick-v1:0', 'bedrock-llama'],
    ['deepseek.v4-v1:0', 'bedrock-deepseek'],
    ['us.deepseek.r2-v1:0', 'bedrock-deepseek'],
  ])('%s -> %s with a complete profile', (id, family) => {
    expect(resolve(id, ModelBackend.Bedrock)).toEqual({
      adapterFamily: family,
      dispatchProfile: { maxTokensParam: 'max_tokens', toolTransport: 'native' },
    });
  });

  it.each([
    ['ai21.j2-ultra-v2', 'jurassic is a legacy family with no new members'],
    ['amazon.titan-text-premier-v1', 'titan is a legacy family with no new members'],
    ['mistral.mistral-large-2411-v1:0', 'no adapter for this vendor'],
    ['no-dots-at-all', 'not a bedrock id namespace'],
  ])('%s resolves to null (%s)', id => {
    expect(resolve(id, ModelBackend.Bedrock)).toBeNull();
  });
});

describe('resolveDispatchForRecord: direct providers', () => {
  it.each([
    [ModelBackend.Anthropic, 'anthropic-messages'],
    [ModelBackend.Gemini, 'gemini'],
    [ModelBackend.XAI, 'xai'],
    [ModelBackend.Ollama, 'ollama'],
    [ModelBackend.BFL, 'bfl'],
    [ModelBackend.LocalImage, 'local-image'],
    [ModelBackend.AWS, 'aws'],
  ])('%s -> %s with a complete profile', (backend, family) => {
    const resolved = resolve('some-new-model', backend);
    expect(resolved?.adapterFamily).toBe(family);
    expect(resolved?.dispatchProfile).toEqual({ maxTokensParam: 'max_tokens', toolTransport: 'native' });
  });

  it('names the OpenAI family but refuses to guess its profile', () => {
    // max_completion_tokens vs max_tokens and chat vs responses are not derivable
    // from an OpenAI id; a guess is the 400 (or the silent no-tool-call) this
    // whole contract exists to prevent.
    expect(resolve('gpt-5.7', ModelBackend.OpenAI)).toEqual({ adapterFamily: 'openai-chat' });
  });

  it('returns null for a backend with no completion adapter', () => {
    expect(resolve('voyage-4', ModelBackend.VoyageAI)).toBeNull();
  });
});

describe('resolveDispatchForRecord: contract with the rest of dispatch', () => {
  it('only ever names a family this build can dispatch', () => {
    const backends = Object.values(ModelBackend);
    const named = backends
      .map(backend => resolve('probe.model-v1:0', backend)?.adapterFamily)
      .filter((family): family is NonNullable<typeof family> => family !== undefined);
    expect(named.length).toBeGreaterThan(0);
    for (const family of named) expect(DISPATCHABLE_ADAPTER_FAMILIES).toContain(family);
  });

  it('every family it can name is a declared AdapterFamily', () => {
    const bedrock = ['anthropic.x', 'meta.x', 'deepseek.x'].map(id => resolve(id, ModelBackend.Bedrock)?.adapterFamily);
    for (const family of bedrock) expect(ADAPTER_FAMILIES).toContain(family);
  });
});

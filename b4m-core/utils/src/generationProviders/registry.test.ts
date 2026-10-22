import { describe, expect, it } from 'vitest';
import { createGenerationProviderRegistry, type ProviderCatalog } from './registry';
import type { SyncGenerationProvider } from './types';

type ModelId = 'alpha-1' | 'alpha-2' | 'beta-1';
type ProviderId = 'alpha' | 'beta';
type Provider = SyncGenerationProvider<ProviderId, ModelId, { prompt: string }>;

const OWNER: Record<ModelId, ProviderId> = { 'alpha-1': 'alpha', 'alpha-2': 'alpha', 'beta-1': 'beta' };
const catalog: ProviderCatalog<ProviderId, ModelId> = {
  label: 'music',
  modelIds: ['alpha-1', 'alpha-2', 'beta-1'],
  providerOf: model => OWNER[model],
};

const provider = (id: ProviderId, models: readonly ModelId[]): Provider => ({
  mode: 'sync',
  id,
  models,
  generate: async () => ({ status: 'succeeded', output: { kind: 'inline', base64: '', contentType: 'audio/mpeg' } }),
  fetchOutput: async () => Buffer.alloc(0),
});

describe('createGenerationProviderRegistry', () => {
  it('registers providers that serve exactly their catalog models', () => {
    const alpha = provider('alpha', ['alpha-1', 'alpha-2']);
    const registry = createGenerationProviderRegistry(catalog, [alpha, provider('beta', ['beta-1'])]);
    expect(registry.get('alpha')).toBe(alpha);
    expect(registry.ids()).toEqual(['alpha', 'beta']);
  });

  it('rejects a provider listing a model the catalog assigns elsewhere', () => {
    expect(() =>
      createGenerationProviderRegistry(catalog, [provider('alpha', ['alpha-1', 'alpha-2', 'beta-1'])])
    ).toThrow('music provider alpha lists beta-1, which the catalog assigns to beta');
  });

  it('rejects a provider missing one of its catalog models', () => {
    expect(() => createGenerationProviderRegistry(catalog, [provider('alpha', ['alpha-1'])])).toThrow(
      'music provider alpha does not list catalog models: alpha-2'
    );
  });

  it('rejects a duplicate provider id', () => {
    const alpha = provider('alpha', ['alpha-1', 'alpha-2']);
    expect(() => createGenerationProviderRegistry(catalog, [alpha, alpha])).toThrow('duplicate music provider: alpha');
  });
});

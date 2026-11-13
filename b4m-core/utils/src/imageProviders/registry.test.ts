import { describe, expect, it } from 'vitest';
import { ALL_IMAGE_MODELS, IMAGE_MODEL_CATALOG, ImageModels } from '@bike4mind/common';
import { createImageProviderRegistry } from './registry';
import { BflImageProvider } from './bfl/BflImageProvider';
import { OpenAIImageProvider } from './openai/OpenAIImageProvider';
import { XaiImageProvider } from './xai/XaiImageProvider';
import type { ImageProvider } from './types';

const stubProvider = (overrides: Partial<ImageProvider> & Pick<ImageProvider, 'id' | 'models'>): ImageProvider => ({
  mode: 'sync',
  generate: async () => {
    throw new Error('not called');
  },
  fetchOutput: async () => Buffer.alloc(0),
  ...overrides,
});

describe('createImageProviderRegistry', () => {
  it('registers the OpenAI provider against the catalog', () => {
    const openai = new OpenAIImageProvider();
    const registry = createImageProviderRegistry([openai]);
    expect(registry.get('openai')).toBe(openai);
    expect(registry.get('bfl')).toBeUndefined();
    expect(registry.ids()).toEqual(['openai']);
  });

  it.each(['bfl', 'xai'] as const)('resolves every %s catalog model to its provider', providerId => {
    const registry = createImageProviderRegistry([new BflImageProvider(), new XaiImageProvider()]);
    const models = ALL_IMAGE_MODELS.filter(model => IMAGE_MODEL_CATALOG[model].provider === providerId);
    expect(models.length).toBeGreaterThan(0);
    const provider = registry.get(providerId);
    expect(provider?.id).toBe(providerId);
    expect([...(provider?.models ?? [])].sort()).toEqual([...models].sort());
  });

  it('rejects a duplicate provider id', () => {
    expect(() => createImageProviderRegistry([new OpenAIImageProvider(), new OpenAIImageProvider()])).toThrow(
      'duplicate image provider: openai'
    );
  });

  it('rejects a provider listing a model the catalog assigns elsewhere', () => {
    const other = (Object.values(ImageModels) as ImageModels[]).find(
      model => IMAGE_MODEL_CATALOG[model].provider !== 'openai'
    );
    if (!other) throw new Error('catalog has no non-openai model');
    const openai = new OpenAIImageProvider();
    const provider = stubProvider({ id: 'openai', models: [...openai.models, other] });
    expect(() => createImageProviderRegistry([provider])).toThrow(
      `image provider openai lists ${other}, which the catalog assigns to ${IMAGE_MODEL_CATALOG[other].provider}`
    );
  });

  it('rejects a provider missing one of its catalog models', () => {
    const [, ...rest] = new OpenAIImageProvider().models;
    expect(() => createImageProviderRegistry([stubProvider({ id: 'openai', models: rest })])).toThrow(
      'image provider openai does not list catalog models'
    );
  });
});

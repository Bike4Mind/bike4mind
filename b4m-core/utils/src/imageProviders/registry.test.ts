import { describe, expect, it } from 'vitest';
import { IMAGE_MODEL_CATALOG, ImageModels } from '@bike4mind/common';
import { createImageProviderRegistry } from './registry';
import { OpenAIImageProvider } from './openai/OpenAIImageProvider';
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

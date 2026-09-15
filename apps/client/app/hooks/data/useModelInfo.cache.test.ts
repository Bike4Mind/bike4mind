import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ModelInfo } from '@bike4mind/common';
import { MODEL_CATALOG_QUERY_KEY, getCachedModels } from './useModelInfo';

/**
 * The ['llm', 'models'] slot holds the whole ModelCatalog, while the hooks project it
 * with `select`. getQueryData returns the stored value, not the selected one, so a raw
 * reader that assumes ModelInfo[] type-checks fine and then throws on `.find`. Callers
 * must go through getCachedModels; these lock that in.
 */
describe('getCachedModels', () => {
  const models = [{ id: 'grok-4.5', name: 'Grok 4.5' }] as unknown as ModelInfo[];

  it('reads the model list out of the cached catalog object', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(MODEL_CATALOG_QUERY_KEY, { models, supersededModels: [] });
    expect(getCachedModels(queryClient)).toBe(models);
  });

  it('returns an array callers can filter, not the catalog object itself', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(MODEL_CATALOG_QUERY_KEY, { models, supersededModels: [] });
    expect(() => getCachedModels(queryClient)?.find(m => m.id === 'grok-4.5')).not.toThrow();
  });

  it('returns undefined before the first fetch', () => {
    expect(getCachedModels(new QueryClient())).toBeUndefined();
  });
});

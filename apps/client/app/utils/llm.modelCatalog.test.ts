import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get } }));

const { getModelCatalog } = await import('./llm');

const model = (id: string, extra: Partial<ModelInfo> = {}) => ({ id, name: id, type: 'text', ...extra }) as ModelInfo;
const lockedModel = (id: string) => model(id, { access: { locked: true, reason: 'requires_paid_plan' } });

/**
 * Locked (paid-only) models are display only: every selection, default and fallback path reads
 * `models`, so a locked entry there would make it selectable again.
 */
describe('getModelCatalog locked models', () => {
  beforeEach(() => get.mockReset());

  it('keeps lockedModels apart from the selectable models', async () => {
    get.mockResolvedValue({
      data: { models: [model('free')], supersededModels: [], lockedModels: [lockedModel('paid')] },
    });

    const catalog = await getModelCatalog();

    expect(catalog.models.map(entry => entry.id)).toEqual(['free']);
    expect(catalog.lockedModels.map(entry => entry.id)).toEqual(['paid']);
  });

  it('drops a locked model that arrives in the selectable list', async () => {
    get.mockResolvedValue({ data: { models: [model('free'), lockedModel('paid')], supersededModels: [] } });

    const catalog = await getModelCatalog();

    expect(catalog.models.map(entry => entry.id)).toEqual(['free']);
  });

  it('defaults lockedModels to empty for a server that does not send it', async () => {
    get.mockResolvedValue({ data: { models: [model('free')] } });

    expect((await getModelCatalog()).lockedModels).toEqual([]);
  });
});

describe('getModelCatalog model-list revision', () => {
  beforeEach(() => get.mockReset());

  it('keeps the revision the server built the list under', async () => {
    get.mockResolvedValue({ data: { models: [model('free')], supersededModels: [], modelListRevision: 'rev-1' } });

    expect((await getModelCatalog()).modelListRevision).toBe('rev-1');
  });

  it('reads a server that sends no revision as null', async () => {
    get.mockResolvedValue({ data: { models: [model('free')] } });

    expect((await getModelCatalog()).modelListRevision).toBeNull();
  });

  it('keeps the flag for a list built without the catalog, and reads its absence as false', async () => {
    get.mockResolvedValueOnce({ data: { models: [model('free')], catalogUnavailable: true } });
    expect((await getModelCatalog()).catalogUnavailable).toBe(true);

    get.mockResolvedValueOnce({ data: { models: [model('free')] } });
    expect((await getModelCatalog()).catalogUnavailable).toBe(false);
  });
});

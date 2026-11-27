import { beforeEach, expect, it, vi } from 'vitest';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get } }));

const { getModelCatalog } = await import('./llm');

beforeEach(() => get.mockReset().mockResolvedValue({ data: { models: [] } }));

it('sends the active organization id as a query param', async () => {
  await getModelCatalog('org-1');
  expect(get).toHaveBeenCalledWith('/api/models', { params: { organizationId: 'org-1' } });
});

it('sends no params without an organization', async () => {
  await getModelCatalog(null);
  expect(get).toHaveBeenCalledWith('/api/models');
});

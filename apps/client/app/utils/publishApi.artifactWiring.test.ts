import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mockGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@client/app/utils/shareFooter', () => ({ buildShareFooterHtml: () => '<footer/>' }));

import { buildArtifactPublishWiring } from './publishApi';

const row = {
  publicId: 'pub-1',
  tier: 'user',
  scopeId: 'u1',
  slug: 'my-artifact',
  title: 'My artifact',
  visibility: 'private',
  publishedAt: '2026-01-02T00:00:00.000Z',
};

const wire = () =>
  buildArtifactPublishWiring({ artifactId: 'art-1', type: 'code', content: 'x', title: 'T', userId: 'u1' });

beforeEach(() => {
  mockGet.mockReset();
});

describe('buildArtifactPublishWiring - resolvePublished', () => {
  it('maps the artifact lookup to a share result with the artifact viewer url', async () => {
    mockGet.mockResolvedValue({ data: { artifacts: [row] } });
    await expect(wire().resolvePublished()).resolves.toEqual({
      publicId: 'pub-1',
      url: '/p/u/u1/my-artifact',
      tier: 'user',
      scopeId: 'u1',
      slug: 'my-artifact',
      visibility: 'private',
      publishedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('returns null when the artifact has no publication', async () => {
    mockGet.mockResolvedValue({ data: { artifacts: [] } });
    await expect(wire().resolvePublished()).resolves.toBeNull();
  });

  it('serves resolveExisting and resolvePublished from a single request', async () => {
    mockGet.mockResolvedValue({ data: { artifacts: [row] } });
    const w = wire();
    await Promise.all([w.resolveExisting(), w.resolvePublished()]);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/api/publish/artifacts?sourceArtifactId=art-1');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mockGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@client/app/utils/shareFooter', () => ({ buildShareFooterHtml: () => '<footer/>' }));

import { findPublishedByReply } from './publishApi';

beforeEach(() => {
  mockGet.mockReset();
});

describe('findPublishedByReply', () => {
  it('queries the owner list by encoded source message id with a limit of one', async () => {
    mockGet.mockResolvedValue({ data: { artifacts: [] } });
    await findPublishedByReply('a b/c');
    expect(mockGet).toHaveBeenCalledWith('/api/publish/artifacts?sourceMessageId=a%20b%2Fc&limit=1');
  });

  it('maps a hit to the share result with a reply viewer url', async () => {
    mockGet.mockResolvedValue({
      data: {
        artifacts: [
          {
            publicId: 'pub-9',
            tier: 'user',
            scopeId: 'u1',
            slug: 's',
            visibility: 'private',
            publishedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      },
    });
    await expect(findPublishedByReply('m1')).resolves.toEqual({
      publicId: 'pub-9',
      url: '/p/r/pub-9',
      tier: 'user',
      scopeId: 'u1',
      slug: 's',
      visibility: 'private',
      publishedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('returns null when nothing is published for the reply', async () => {
    mockGet.mockResolvedValue({ data: { artifacts: [] } });
    await expect(findPublishedByReply('m1')).resolves.toBeNull();
  });

  it('returns null when the request fails', async () => {
    mockGet.mockRejectedValue(new Error('network'));
    await expect(findPublishedByReply('m1')).resolves.toBeNull();
  });
});

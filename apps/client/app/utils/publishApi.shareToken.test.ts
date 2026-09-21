import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * getShareTokenState is the read-only half of the share-link API: it must hit the
 * GET, never the minting POST, since the whole point is that rendering an owner
 * surface cannot create a link. A wrong URL string here fails silently at runtime,
 * so the request shape is pinned.
 */

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mockGet, post: mockPost, patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('@client/app/utils/shareFooter', () => ({ buildShareFooterHtml: () => '<footer/>' }));

import { getShareTokenState } from './publishApi';

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('getShareTokenState', () => {
  it('GETs the share-token route and returns its state without minting', async () => {
    mockGet.mockResolvedValue({
      data: {
        hasShareToken: true,
        shareToken: 'TOKEN',
        shareUrl: '/a/TOKEN',
        shareTokenUpdatedAt: '2026-09-14T00:00:00.000Z',
      },
    });

    const state = await getShareTokenState('pub-1');

    expect(mockGet).toHaveBeenCalledWith('/api/publish/pub-1/share-token');
    expect(mockPost).not.toHaveBeenCalled();
    expect(state.hasShareToken).toBe(true);
    expect(state.shareToken).toBe('TOKEN');
  });

  it('passes through the no-link state', async () => {
    mockGet.mockResolvedValue({
      data: { hasShareToken: false, shareToken: null, shareUrl: null, shareTokenUpdatedAt: null },
    });

    const state = await getShareTokenState('pub-1');

    expect(state).toEqual({
      hasShareToken: false,
      shareToken: null,
      shareUrl: null,
      shareTokenUpdatedAt: null,
    });
  });
});

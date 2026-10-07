import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * getShareTokenState is the read-only half of the share-link API: it must hit the
 * GET, never the minting POST, since the whole point is that rendering an owner
 * surface cannot create a link. A wrong URL string here fails silently at runtime,
 * so the request shape is pinned.
 */

const { mockGet, mockPost, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mockGet, post: mockPost, patch: vi.fn(), delete: mockDelete },
}));

vi.mock('@client/app/utils/shareFooter', () => ({ buildShareFooterHtml: () => '<footer/>' }));

import { getShareTokenState, createAdditionalShareToken, revokeShareLink, revokeShareToken } from './publishApi';

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockDelete.mockReset();
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

describe('createAdditionalShareToken', () => {
  it('POSTs additional:true, so the call adds a link instead of returning the existing one', async () => {
    // The difference from createOrGetShareToken is the whole point: that one is idempotent and
    // would hand back the live link rather than minting a second audience's.
    mockPost.mockResolvedValue({
      data: { id: 'entry-2', shareToken: 'NEW', shareUrl: '/a/NEW', shareLinks: [] },
    });

    const minted = await createAdditionalShareToken('pub-1');

    expect(mockPost).toHaveBeenCalledWith('/api/publish/pub-1/share-token', { additional: true });
    expect(minted.id).toBe('entry-2');
    expect(minted.shareToken).toBe('NEW');
  });
});

describe('revokeShareLink', () => {
  it('DELETEs one link by id and reports the survivors', async () => {
    mockDelete.mockResolvedValue({ data: { revoked: true, remaining: 2 } });

    const result = await revokeShareLink('pub-1', 'entry-1');

    expect(mockDelete).toHaveBeenCalledWith('/api/publish/pub-1/share-token?id=entry-1');
    expect(result).toEqual({ remaining: 2 });
  });

  it('encodes the id, so a stray character cannot forge query parameters', async () => {
    mockDelete.mockResolvedValue({ data: { revoked: true, remaining: 0 } });

    await revokeShareLink('pub-1', 'a&b=c');

    expect(mockDelete).toHaveBeenCalledWith('/api/publish/pub-1/share-token?id=a%26b%3Dc');
  });

  it('revokeShareToken still sends the id-less DELETE that revokes every link', async () => {
    mockDelete.mockResolvedValue({ data: { revoked: true, remaining: 0 } });

    await revokeShareToken('pub-1');

    expect(mockDelete).toHaveBeenCalledWith('/api/publish/pub-1/share-token');
  });
});

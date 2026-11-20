// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  findListing: vi.fn(),
  detail: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => {
  const chain = {
    get: (fn: (req: unknown, res: unknown) => Promise<void>) => {
      h.handlers.get = fn;
      return chain;
    },
    delete: (fn: (req: unknown, res: unknown) => Promise<void>) => {
      h.handlers.delete = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({
  findListing: (...a: unknown[]) => h.findListing(...a),
}));
vi.mock('@server/skillMarket/author', () => ({ withdrawOwnListing: vi.fn() }));
vi.mock('@server/skillMarket/detail', () => ({ buildListingDetail: (...a: unknown[]) => h.detail(...a) }));

import '../index';

describe('GET /api/skills/market/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findListing.mockResolvedValue({ id: 'listing-1' });
    h.detail.mockResolvedValue({ listing: { id: 'listing-1' } });
  });

  it('does not forward a ?token= query param to the detail builder', async () => {
    const json = vi.fn();
    await h.handlers.get(
      { query: { id: 'listing-1', token: 'a'.repeat(32) }, user: { id: 'user-1', isAdmin: false } },
      { json }
    );

    expect(h.detail).toHaveBeenCalledTimes(1);
    expect(h.detail).toHaveBeenCalledWith({ id: 'listing-1' }, { id: 'user-1', isAdmin: false });
    expect(json).toHaveBeenCalledWith({ listing: { id: 'listing-1' } });
  });
});

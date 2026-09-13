import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../client.js', () => ({
  notionRequest: vi.fn(),
}));

import { notionRequest } from '../../client.js';
import { clearParentCache, normalizeId, resolveParentId } from '../../helpers/ancestry.js';

const PAGE_ID = 'aaaa1111-bbbb-cccc-dddd-eeee22223333';
const PARENT_ID = 'bbbb1111-cccc-dddd-eeee-ffff00001111';

describe('resolveParentId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearParentCache();
  });

  it('does not cache a transient lookup failure as "no parent"', async () => {
    // Both probes fail: /pages first, then the /blocks fallback
    vi.mocked(notionRequest)
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockRejectedValueOnce(new Error('socket hang up'));

    expect(await resolveParentId(PAGE_ID)).toBeNull();
    expect(notionRequest).toHaveBeenCalledTimes(2);

    vi.mocked(notionRequest).mockResolvedValueOnce({
      id: PAGE_ID,
      parent: { type: 'page_id', page_id: PARENT_ID },
    });

    // A cached failure would deny this page for 60s without ever re-asking Notion
    expect(await resolveParentId(PAGE_ID)).toBe(normalizeId(PARENT_ID));
    expect(notionRequest).toHaveBeenCalledTimes(3);
  });

  it('caches a successful lookup', async () => {
    vi.mocked(notionRequest).mockResolvedValueOnce({
      id: PAGE_ID,
      parent: { type: 'page_id', page_id: PARENT_ID },
    });

    const first = await resolveParentId(PAGE_ID);
    expect(first).toBe(normalizeId(PARENT_ID));
    expect(notionRequest).toHaveBeenCalledTimes(1);

    const second = await resolveParentId(PAGE_ID);
    expect(second).toBe(first);
    expect(notionRequest).toHaveBeenCalledTimes(1);
  });
});

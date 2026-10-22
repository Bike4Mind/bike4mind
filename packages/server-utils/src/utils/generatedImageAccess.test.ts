// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ findSessionIdsByImage: vi.fn(), findAllAccessibleByIds: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  questRepository: { findSessionIdsByImage: h.findSessionIdsByImage },
  sessionRepository: { shareable: { findAllAccessibleByIds: h.findAllAccessibleByIds } },
}));

import { userCanAccessGeneratedImage } from './generatedImageAccess';

const USER = { id: 'me', groups: ['g1'] };

beforeEach(() => {
  vi.clearAllMocks();
  h.findSessionIdsByImage.mockResolvedValue(['s1', 's2']);
});

describe('userCanAccessGeneratedImage', () => {
  it('resolves the key to sessions and asks the shareable reader, including soft-deleted ones', async () => {
    h.findAllAccessibleByIds.mockResolvedValue([{ id: 's2' }]);

    await expect(userCanAccessGeneratedImage('a.png', USER)).resolves.toBe(true);

    expect(h.findSessionIdsByImage).toHaveBeenCalledWith('a.png');
    expect(h.findAllAccessibleByIds).toHaveBeenCalledWith(USER, ['s1', 's2'], { includeDeleted: true });
  });

  it('is false when none of the sessions is readable by the user', async () => {
    h.findAllAccessibleByIds.mockResolvedValue([]);

    await expect(userCanAccessGeneratedImage('a.png', USER)).resolves.toBe(false);
  });

  it('is false without a lookup for an orphaned key', async () => {
    h.findSessionIdsByImage.mockResolvedValue([]);

    await expect(userCanAccessGeneratedImage('a.png', USER)).resolves.toBe(false);
    expect(h.findAllAccessibleByIds).not.toHaveBeenCalled();
  });

  it('is false without any lookup for an empty key or user id', async () => {
    await expect(userCanAccessGeneratedImage('', USER)).resolves.toBe(false);
    await expect(userCanAccessGeneratedImage('a.png', { id: '', groups: [] })).resolves.toBe(false);
    expect(h.findSessionIdsByImage).not.toHaveBeenCalled();
  });
});

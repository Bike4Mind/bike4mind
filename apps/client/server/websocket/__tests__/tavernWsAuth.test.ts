import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

/**
 * Unit test for the WS Tavern gate predicate wiring.
 *
 * Complements tavernSceneCommand.test.ts (which mocks this gate to a boolean to
 * test the handler's short-circuit). Here we exercise the REAL gate end to end:
 * the projected User.findById load feeds the real `canAccessTavern` predicate.
 * Only the DB layer is mocked, so admin / 'tavern'-tag / plain / missing-user all
 * flow through the actual predicate, and the fail-closed null case is verified.
 */

vi.mock('@bike4mind/database', () => ({
  User: { findById: vi.fn() },
}));

import { User } from '@bike4mind/database';
import { connectionUserCanAccessTavern } from '../tavernWsAuth';

const mockUserDoc = (doc: unknown) => (User.findById as Mock).mockReturnValue({ lean: () => Promise.resolve(doc) });

describe('connectionUserCanAccessTavern - WS Tavern gate predicate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows an admin', async () => {
    mockUserDoc({ isAdmin: true, tags: [] });
    expect(await connectionUserCanAccessTavern('user-admin')).toBe(true);
  });

  it("allows a non-admin holding the 'tavern' tag", async () => {
    mockUserDoc({ isAdmin: false, tags: ['tavern'] });
    expect(await connectionUserCanAccessTavern('user-tagged')).toBe(true);
  });

  it('denies a plain user (not admin, no tavern tag)', async () => {
    mockUserDoc({ isAdmin: false, tags: ['Customer'] });
    expect(await connectionUserCanAccessTavern('user-plain')).toBe(false);
  });

  it('denies a missing / deleted user (fail-closed)', async () => {
    mockUserDoc(null);
    expect(await connectionUserCanAccessTavern('user-gone')).toBe(false);
  });

  it('reads only the isAdmin + tags projection', async () => {
    mockUserDoc({ isAdmin: true, tags: [] });
    await connectionUserCanAccessTavern('user-x');
    expect(User.findById).toHaveBeenCalledWith('user-x', { isAdmin: 1, tags: 1 });
  });
});

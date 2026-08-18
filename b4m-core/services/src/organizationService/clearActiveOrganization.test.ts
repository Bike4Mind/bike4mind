import { clearActiveOrganization } from './clearActiveOrganization';
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('clearActiveOrganization', () => {
  let db: any;

  beforeEach(() => {
    vi.clearAllMocks();
    db = { users: { update: vi.fn().mockResolvedValue(undefined) } };
  });

  const run = (actingUser: { id: string; isAdmin: boolean }, userId: string) =>
    clearActiveOrganization(actingUser as any, { userId }, { db });

  it('clears the pointer when a user clears their own', async () => {
    await run({ id: 'u1', isAdmin: false }, 'u1');
    expect(db.users.update).toHaveBeenCalledWith({ id: 'u1', organizationId: null });
  });

  it("lets a platform admin clear another user's pointer", async () => {
    await run({ id: 'admin1', isAdmin: true }, 'victim');
    expect(db.users.update).toHaveBeenCalledWith({ id: 'victim', organizationId: null });
  });

  it("refuses a non-admin clearing another user's pointer and writes nothing", async () => {
    await expect(run({ id: 'u1', isAdmin: false }, 'u2')).rejects.toThrow(/not authorized/i);
    expect(db.users.update).not.toHaveBeenCalled();
  });

  it('rejects an empty userId (schema guard) before any write', async () => {
    await expect(run({ id: 'u1', isAdmin: true }, '')).rejects.toThrow();
    expect(db.users.update).not.toHaveBeenCalled();
  });
});

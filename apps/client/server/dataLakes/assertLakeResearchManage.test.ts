import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError } from '@bike4mind/utils';

const h = vi.hoisted(() => ({
  assertLakeAccessById: vi.fn(),
  loadActiveLakeGrants: vi.fn(),
  canManageLake: vi.fn(),
}));

vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccessById: h.assertLakeAccessById,
    loadActiveLakeGrants: h.loadActiveLakeGrants,
    canManageLake: h.canManageLake,
  },
}));
vi.mock('@bike4mind/database', () => ({ dataLakeRepository: {}, dataLakeAccessGrantRepository: {} }));

import { assertLakeResearchManage } from './assertLakeResearchManage';

const req = (apiKeyInfo?: { keyId: string }) => ({ user: { id: 'u1' }, apiKeyInfo }) as never;
const lake = { id: 'lake-oid-1', name: 'Ops Lake' };
const ctx = { userId: 'u1', isAdmin: false, administeredOrgIds: [] };
const grants = [{ principalType: 'user', principalId: 'u1', role: 'curator' }];

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeAccessById.mockResolvedValue(lake);
  h.loadActiveLakeGrants.mockResolvedValue(grants);
  h.canManageLake.mockReturnValue(true);
});

describe('assertLakeResearchManage', () => {
  // By id only: a slug skips a deleted lake and resolves the next lake sharing it, so a research
  // write addressed by slug could land on (and spend money on) a lake the caller never meant.
  it('resolves the path lake through the id-only gate and returns it for a manager', async () => {
    const { lake: resolved } = await assertLakeResearchManage(req(), 'my-lake', ctx);
    expect(resolved).toBe(lake);
    expect(h.assertLakeAccessById).toHaveBeenCalledWith('my-lake', expect.anything(), expect.anything());
  });

  // The actor these routes need to record a History event, built once here (matching
  // grants.ts/lifecycle.ts) rather than re-derived at each of the three call sites.
  it('also hands back the ManageActor built from the same AccessContext', async () => {
    const { actor } = await assertLakeResearchManage(req(), 'my-lake', ctx);
    expect(actor).toMatchObject({ userId: 'u1', isAdmin: false, administeredOrgIds: [] });
  });

  // A session write needs no override - only an API-key caller does. Deleting this wiring would
  // still pass every OTHER assertion in this file, which is exactly why it needs its own test.
  it('attaches auditPrincipal only for an API-key caller, never for a session', async () => {
    const { actor: sessionActor } = await assertLakeResearchManage(req(), 'my-lake', ctx);
    expect(sessionActor.auditPrincipal).toBeUndefined();

    const { actor: keyActor } = await assertLakeResearchManage(req({ keyId: 'key-1' }), 'my-lake', ctx);
    expect(keyActor.auditPrincipal).toMatchObject({ principalKind: 'apiKey' });
  });

  // The gate and the recorded History rung must agree on the same grant set, so the gate
  // hands its own grants back rather than making each write re-fetch (or silently get none).
  it('also hands back the active grants it loaded for the gate', async () => {
    const { grants: resolved } = await assertLakeResearchManage(req(), 'my-lake', ctx);
    expect(resolved).toBe(grants);
  });

  // Configuring what a run searches for, and spending money running it, are management rights.
  it('refuses a caller who can read the lake but not manage it', async () => {
    h.canManageLake.mockReturnValue(false);

    await expect(assertLakeResearchManage(req(), 'my-lake', ctx)).rejects.toThrow(
      /permission to manage research runs/i
    );
    // Not just the message text: a same-worded BadRequestError (or any other type) must not pass
    // this test - callers rely on the 403 status ForbiddenError specifically maps to.
    await expect(assertLakeResearchManage(req(), 'my-lake', ctx)).rejects.toThrow(ForbiddenError);
  });

  // Existence must never be probeable through a 403: the read gate answers not-found first.
  it('runs the read gate before the manage gate', async () => {
    h.assertLakeAccessById.mockRejectedValue(new Error('Data lake not found'));

    await expect(assertLakeResearchManage(req(), 'someone-elses-lake', ctx)).rejects.toThrow(/not found/i);
    expect(h.canManageLake).not.toHaveBeenCalled();
  });

  it('resolves manage against the RESOLVED lake and its own loaded grants, not the raw path id', async () => {
    await assertLakeResearchManage(req(), 'my-lake', ctx);

    expect(h.loadActiveLakeGrants).toHaveBeenCalledWith(lake, expect.anything());
    expect(h.canManageLake).toHaveBeenCalledWith(lake, expect.anything(), grants);
  });
});

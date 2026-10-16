import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

// Hoisted so the vi.mock factory (itself hoisted above imports) can reference them safely.
const { mockFindAccessibleById, mockFindById } = vi.hoisted(() => ({
  mockFindAccessibleById: vi.fn(),
  mockFindById: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  organizationRepository: {
    findById: mockFindById,
    shareable: {
      findAccessibleById: mockFindAccessibleById,
    },
  },
}));

import { resolveActiveOrg } from './resolveActiveOrg';
import { ForbiddenError, NotFoundError } from '@bike4mind/common';

// Minimal principal - resolveActiveOrg only reads `isAdmin` and passes the user through to
// the share-access gate, so a partial cast is enough.
const asReq = (user: { id: string; isAdmin?: boolean }): Request => ({ user }) as unknown as Request;

describe('resolveActiveOrg', () => {
  beforeEach(() => {
    mockFindAccessibleById.mockReset();
    mockFindById.mockReset();
  });

  it('returns undefined (personal scope) when no org id is supplied', async () => {
    const result = await resolveActiveOrg(asReq({ id: 'u1' }), undefined);
    expect(result).toBeUndefined();
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
  });

  it('returns undefined when the supplied org id is empty/whitespace', async () => {
    expect(await resolveActiveOrg(asReq({ id: 'u1' }), '')).toBeUndefined();
    expect(await resolveActiveOrg(asReq({ id: 'u1' }), '   ')).toBeUndefined();
    expect(await resolveActiveOrg(asReq({ id: 'u1' }), null)).toBeUndefined();
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
  });

  it('trims and returns the org id for a member the gate grants', async () => {
    mockFindAccessibleById.mockResolvedValue({ id: 'org1', name: 'Acme' });
    const result = await resolveActiveOrg(asReq({ id: 'u1' }), '  org1  ');
    expect(result).toBe('org1');
    expect(mockFindAccessibleById).toHaveBeenCalledWith({ id: 'u1', isAdmin: undefined }, 'org1');
  });

  it('rejects a caller who is not a member of the requested org', async () => {
    mockFindAccessibleById.mockResolvedValue(null);
    await expect(resolveActiveOrg(asReq({ id: 'u1' }), 'org-i-dont-belong-to')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets an admin scope to any existing org without a membership read', async () => {
    mockFindById.mockResolvedValue({ id: 'org1', name: 'Acme' });
    const result = await resolveActiveOrg(asReq({ id: 'admin', isAdmin: true }), 'org1');
    expect(result).toBe('org1');
    expect(mockFindById).toHaveBeenCalledWith('org1');
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
  });

  it('rejects an admin scoping to a non-existent org (fails closed on a typo)', async () => {
    mockFindById.mockResolvedValue(null);
    await expect(resolveActiveOrg(asReq({ id: 'admin', isAdmin: true }), 'org-does-not-exist')).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
  });

  it('treats a malformed admin org id (CastError) as not-found, not a 5xx', async () => {
    mockFindById.mockRejectedValue(Object.assign(new Error('Cast to ObjectId failed'), { name: 'CastError' }));
    await expect(resolveActiveOrg(asReq({ id: 'admin', isAdmin: true }), 'not-an-objectid')).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it('propagates a transient DB error on the admin path instead of masking it as not-found', async () => {
    const dbErr = new Error('connection reset');
    mockFindById.mockRejectedValue(dbErr);
    await expect(resolveActiveOrg(asReq({ id: 'admin', isAdmin: true }), 'org1')).rejects.toBe(dbErr);
  });
});

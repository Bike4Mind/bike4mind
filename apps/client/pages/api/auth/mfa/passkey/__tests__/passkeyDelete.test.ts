import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = { use: () => chain, delete: (fn: unknown) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/auth/stepUp', () => ({ stepUpGate: () => () => undefined }));

const mockLogAuthAudit = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: (...a: unknown[]) => mockLogAuthAudit(...a) }));

const mockFindById = vi.fn();
const mockUpdate = vi.fn();
const mockCountByUser = vi.fn();
const mockRemove = vi.fn();
const mockRemoveUnlessLast = vi.fn();
vi.mock('@bike4mind/database', () => ({
  userRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
  passkeyCredentialRepository: {
    countByUser: (...a: unknown[]) => mockCountByUser(...a),
    remove: (...a: unknown[]) => mockRemove(...a),
    removeUnlessLast: (...a: unknown[]) => mockRemoveUnlessLast(...a),
  },
}));

import deleteHandler from '@pages/api/auth/mfa/passkey/[id]';

const run = async () => {
  const { req, res } = createMocks({ method: 'DELETE' });
  Object.assign(req, { user: { id: 'user-1' } });
  Object.assign(req, { query: { id: 'pk-1' } });
  await deleteHandler(req as never, res as never);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRemove.mockResolvedValue(true);
  mockRemoveUnlessLast.mockResolvedValue('removed');
});

describe('DELETE /api/auth/mfa/passkey/[id]', () => {
  it('refuses to remove the last passkey of a passkey-only user', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', mfa: { passkeyEnabled: true } });
    mockCountByUser.mockResolvedValue(1);

    const res = await run();

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({ code: 'last_factor' });
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockRemoveUnlessLast).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('removes one of several passkeys from a passkey-only user and leaves the flag on', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', mfa: { passkeyEnabled: true } });
    mockCountByUser.mockResolvedValue(2);

    const res = await run();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ removed: true, id: 'pk-1' });
    expect(mockRemoveUnlessLast).toHaveBeenCalledWith('pk-1', 'user-1');
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLogAuthAudit.mock.calls[0][1]).toMatchObject({ event: 'passkey_removed' });
  });

  it('refuses when a concurrent removal took the other passkey first', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', mfa: { passkeyEnabled: true } });
    mockCountByUser.mockResolvedValue(2);
    mockRemoveUnlessLast.mockResolvedValue('last');

    const res = await run();

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({ code: 'last_factor' });
    expect(mockLogAuthAudit).not.toHaveBeenCalled();
  });

  it('answers 404 when a passkey-only user removes an unknown passkey', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', mfa: { passkeyEnabled: true } });
    mockCountByUser.mockResolvedValue(2);
    mockRemoveUnlessLast.mockResolvedValue('not_found');

    await expect(run()).rejects.toThrow('Passkey not found');
  });

  it('clears passkeyEnabled when a TOTP user removes their last passkey', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', mfa: { totpEnabled: true, passkeyEnabled: true } });
    mockCountByUser.mockResolvedValue(0);

    const res = await run();

    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1', 'mfa.passkeyEnabled': false }));
  });

  it('keeps passkeyEnabled when a TOTP user still has other passkeys', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', mfa: { totpEnabled: true, passkeyEnabled: true } });
    mockCountByUser.mockResolvedValue(1);

    await run();

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does not clear the flag when the passkey was not found', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', mfa: { totpEnabled: true, passkeyEnabled: true } });
    mockCountByUser.mockResolvedValue(0);
    mockRemove.mockResolvedValue(false);

    await expect(run()).rejects.toThrow('Passkey not found');
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

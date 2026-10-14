import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { USER_SECRET_FIELDS } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: any) => fn }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findByIdWithMfaSecrets: vi.fn().mockResolvedValue({ id: 'u1' }) },
}));

vi.mock('@bike4mind/services', async () => {
  const { USER_SECRET_FIELDS: fields } = await import('@bike4mind/common');
  const secrets = Object.fromEntries(fields.map(f => [f, 'x']));
  return {
    mfaService: {
      regenerateBackupCodes: vi.fn().mockResolvedValue({ backupCodes: ['aaaa-bbbb'], user: { id: 'u1', ...secrets } }),
    },
  };
});

import handler from '../regenerate-backup-codes';

describe('POST /api/auth/mfa/regenerate-backup-codes', () => {
  it('returns only the new backup codes and none of the user secret fields', async () => {
    const { req, res } = createMocks({ method: 'POST' });
    (req as any).user = { id: 'u1' };
    await (handler as any)(req, res);

    const body = res._getJSONData();
    expect(body).toEqual({ backupCodes: ['aaaa-bbbb'] });
    for (const f of USER_SECRET_FIELDS) expect(body).not.toHaveProperty(f);
  });
});

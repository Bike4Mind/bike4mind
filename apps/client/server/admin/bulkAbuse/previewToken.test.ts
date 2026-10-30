import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));

import { signBulkAbusePreviewToken, verifyBulkAbusePreviewToken } from './previewToken';

const ADMIN_ID = 'a'.repeat(24);
const BOUND = '6a00000000000000ffffffff';

// Signs with the same secret and algorithm as the real token, so each case differs in one claim only.
const forge = (payload: Record<string, unknown>, options: jwt.SignOptions = {}) =>
  jwt.sign(payload, 'test-secret', { algorithm: 'HS256', expiresIn: 60, ...options });

describe('bulk abuse preview token', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips the admin, fingerprint and bound', () => {
    const token = signBulkAbusePreviewToken(ADMIN_ID, 'fp', BOUND);
    expect(verifyBulkAbusePreviewToken(token)).toEqual({ adminId: ADMIN_ID, fingerprint: 'fp', upToUserId: BOUND });
  });

  it('carries a missing bound as null', () => {
    expect(verifyBulkAbusePreviewToken(signBulkAbusePreviewToken(ADMIN_ID, 'fp', null))?.upToUserId).toBeNull();
  });

  it('rejects a token after 15 minutes', () => {
    vi.useFakeTimers();
    const token = signBulkAbusePreviewToken(ADMIN_ID, 'fp', null);
    vi.advanceTimersByTime(15 * 60 * 1000 - 1000);
    expect(verifyBulkAbusePreviewToken(token)).not.toBeNull();
    vi.advanceTimersByTime(2000);
    expect(verifyBulkAbusePreviewToken(token)).toBeNull();
  });

  it('rejects a login JWT signed with the same secret', () => {
    expect(verifyBulkAbusePreviewToken(forge({ id: ADMIN_ID, typ: 'access' }, { subject: ADMIN_ID }))).toBeNull();
  });

  it.each([
    ['a missing typ', { fingerprint: 'fp' }],
    ['a wrong typ', { fingerprint: 'fp', typ: 'access' }],
  ])('rejects the right audience with %s', (_name, payload) => {
    expect(
      verifyBulkAbusePreviewToken(forge(payload, { audience: 'bulk-abuse-preview', subject: ADMIN_ID }))
    ).toBeNull();
  });

  it('rejects the right typ with the wrong audience', () => {
    const token = forge({ fingerprint: 'fp', typ: 'bulk-abuse-preview' }, { audience: 'other', subject: ADMIN_ID });
    expect(verifyBulkAbusePreviewToken(token)).toBeNull();
  });

  it('rejects a token without a subject or a string fingerprint', () => {
    const base = { audience: 'bulk-abuse-preview' };
    expect(verifyBulkAbusePreviewToken(forge({ fingerprint: 'fp', typ: 'bulk-abuse-preview' }, base))).toBeNull();
    expect(
      verifyBulkAbusePreviewToken(forge({ fingerprint: 7, typ: 'bulk-abuse-preview' }, { ...base, subject: ADMIN_ID }))
    ).toBeNull();
  });

  it('treats a non-string bound as no bound', () => {
    const token = forge(
      { fingerprint: 'fp', upToUserId: 5, typ: 'bulk-abuse-preview' },
      { audience: 'bulk-abuse-preview', subject: ADMIN_ID }
    );
    expect(verifyBulkAbusePreviewToken(token)?.upToUserId).toBeNull();
  });

  it('rejects a token signed with another secret', () => {
    const token = jwt.sign({ fingerprint: 'fp', typ: 'bulk-abuse-preview' }, 'other', {
      algorithm: 'HS256',
      audience: 'bulk-abuse-preview',
      subject: ADMIN_ID,
    });
    expect(verifyBulkAbusePreviewToken(token)).toBeNull();
  });
});

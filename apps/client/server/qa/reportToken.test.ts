import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const { mockFindUser } = vi.hoisted(() => ({ mockFindUser: vi.fn() }));

vi.mock('@server/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));
vi.mock('@bike4mind/database', () => ({ User: { findById: (...a: unknown[]) => mockFindUser(...a) } }));

import { signQaReportToken, verifyQaReportToken } from './reportToken';
import { verifyJwtPayload, type JwtPayloadClaims } from '@server/auth/verifyJwtPayload';

describe('report token', () => {
  it('round-trips the run id', () => {
    expect(verifyQaReportToken(signQaReportToken('run-a'))).toEqual({ runId: 'run-a' });
  });
  it('rejects a login JWT signed with the same secret', () => {
    expect(verifyQaReportToken(jwt.sign({ runId: 'run-a' }, 'test-secret'))).toBeNull();
  });
  it('rejects a token with the right audience but no typ', () => {
    expect(verifyQaReportToken(jwt.sign({ runId: 'run-a' }, 'test-secret', { audience: 'qa-report' }))).toBeNull();
  });
  it('rejects an expired token', () => {
    const old = jwt.sign({ runId: 'run-a', typ: 'qa-report' }, 'test-secret', { audience: 'qa-report', expiresIn: -1 });
    expect(verifyQaReportToken(old)).toBeNull();
  });
  it('rejects garbage', () => {
    expect(verifyQaReportToken('nope')).toBeNull();
  });

  it('is rejected by the login verifier on typ, not just on the missing user id', async () => {
    // A user lookup that would succeed, so only the typ guard can reject.
    mockFindUser.mockResolvedValue({ id: 'u1', tokenVersion: 0, isSystem: false });
    const claims = jwt.decode(signQaReportToken('run-a')) as JwtPayloadClaims;
    const done = vi.fn();
    await verifyJwtPayload(claims, done);
    expect(done).toHaveBeenCalledWith(null, false);
    expect(mockFindUser).not.toHaveBeenCalled();
  });
});

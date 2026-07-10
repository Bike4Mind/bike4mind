import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import { gateCookieName, signGateToken, verifyGateToken, requestHasGateProof } from './publishGateToken';

const reqWithCookie = (cookieHeader?: string) => ({ headers: { cookie: cookieHeader } }) as unknown as Request;

describe('publishGateToken', () => {
  it('round-trips claims for the same artifact', () => {
    const token = signGateToken({ publicId: 'abc123' });
    expect(verifyGateToken(token)).toEqual({ publicId: 'abc123' });
  });

  it('rejects tokens signed for another audience (no cross-route replay)', () => {
    const foreign = jwt.sign({ publicId: 'abc123' }, 'test-jwt-secret', { audience: 'some-other-route' });
    expect(verifyGateToken(foreign)).toBeNull();
  });

  it('rejects garbage and wrong-secret tokens without throwing', () => {
    expect(verifyGateToken('not-a-jwt')).toBeNull();
    const wrongSecret = jwt.sign({ publicId: 'abc123' }, 'attacker-secret', {
      audience: 'publish-passphrase-gate',
    });
    expect(verifyGateToken(wrongSecret)).toBeNull();
  });

  it('cookie names only mint for URL-safe publicIds', () => {
    expect(gateCookieName('abc_XYZ-123')).toBe('b4m_pg_abc_XYZ-123');
    expect(gateCookieName('bad;id')).toBeNull();
    expect(gateCookieName('')).toBeNull();
  });

  it('requestHasGateProof matches only the SAME artifact — a proof for A grants nothing on B', () => {
    const token = signGateToken({ publicId: 'artifactA' });
    const req = reqWithCookie(`b4m_pg_artifactA=${token}; other=1`);
    expect(requestHasGateProof(req, 'artifactA')).toBe(true);
    expect(requestHasGateProof(req, 'artifactB')).toBe(false);
    expect(requestHasGateProof(reqWithCookie(undefined), 'artifactA')).toBe(false);
  });
});

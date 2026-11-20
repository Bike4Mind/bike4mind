import { describe, it, expect, vi } from 'vitest';

// apps/client/vitest.setup.ts mocks sst globally; this package does not, and utils/config reads
// its secrets from Resource at import.
vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, { get: (_, key) => ({ value: `test-${String(key)}` }) }),
}));
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import { Config } from '../../utils/config';
import {
  gateCookieName,
  gateProofSecondsLeft,
  signGateToken,
  verifyGateToken,
  requestHasGateProof,
} from './publishGateToken';

const reqWithCookie = (cookieHeader?: string) => ({ headers: { cookie: cookieHeader } }) as unknown as Request;

describe('publishGateToken', () => {
  it('round-trips claims for the same artifact', () => {
    const token = signGateToken({ publicId: 'abc123' });
    expect(verifyGateToken(token)).toEqual({ publicId: 'abc123' });
  });

  it('rejects tokens signed for another audience (no cross-route replay)', () => {
    // Sign with the SAME secret verifyGateToken uses, so the only thing being
    // tested is the audience mismatch (not an incidental secret mismatch).
    const foreign = jwt.sign({ publicId: 'abc123' }, Config.JWT_SECRET, { audience: 'some-other-route' });
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

  it('requestHasGateProof matches only the SAME artifact - a proof for A grants nothing on B', () => {
    const token = signGateToken({ publicId: 'artifactA' });
    const req = reqWithCookie(`b4m_pg_artifactA=${token}; other=1`);
    expect(requestHasGateProof(req, 'artifactA')).toBe(true);
    expect(requestHasGateProof(req, 'artifactB')).toBe(false);
    expect(requestHasGateProof(reqWithCookie(undefined), 'artifactA')).toBe(false);
  });
});

describe('gateProofSecondsLeft', () => {
  it('reports the time left on a valid proof for this artifact', () => {
    const token = signGateToken({ publicId: 'abc123' });
    const exp = (jwt.decode(token) as { exp: number }).exp;
    const req = reqWithCookie(`b4m_pg_abc123=${token}`);
    expect(gateProofSecondsLeft(req, 'abc123', (exp - 600) * 1000)).toBe(600);
  });

  it('is null without a valid proof for this artifact', () => {
    const other = signGateToken({ publicId: 'other' });
    expect(gateProofSecondsLeft(reqWithCookie(), 'abc123')).toBeNull();
    expect(gateProofSecondsLeft(reqWithCookie(`b4m_pg_abc123=${other}`), 'abc123')).toBeNull();
    expect(gateProofSecondsLeft(reqWithCookie('b4m_pg_abc123=garbage'), 'abc123')).toBeNull();
  });
});

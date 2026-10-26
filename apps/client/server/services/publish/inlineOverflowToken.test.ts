import { describe, it, expect, vi, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { Config } from '@bike4mind/server-utils/utils/config';
import { signGateToken } from './publishGateToken';
import { OVERFLOW_TOKEN_TTL_SECONDS, signOverflowAssetToken, verifyOverflowAssetToken } from './inlineOverflowToken';

describe('inlineOverflowToken', () => {
  afterEach(() => vi.useRealTimers());

  it('verifies for the same artifact and path', () => {
    const token = signOverflowAssetToken({ publicId: 'abc123', path: 'img/a.png' });
    expect(verifyOverflowAssetToken(token, 'abc123', 'img/a.png')).toBe(true);
  });

  it('rejects another path or another artifact', () => {
    const token = signOverflowAssetToken({ publicId: 'abc123', path: 'img/a.png' });
    expect(verifyOverflowAssetToken(token, 'abc123', 'img/b.png')).toBe(false);
    expect(verifyOverflowAssetToken(token, 'other', 'img/a.png')).toBe(false);
  });

  it('rejects a passphrase-gate proof (no cross-audience replay)', () => {
    expect(verifyOverflowAssetToken(signGateToken({ publicId: 'abc123' }), 'abc123', 'img/a.png')).toBe(false);
    const noPath = jwt.sign({ publicId: 'abc123' }, Config.JWT_SECRET, { audience: 'publish-inline-overflow' });
    expect(verifyOverflowAssetToken(noPath, 'abc123', 'img/a.png')).toBe(false);
  });

  it('rejects an expired token', () => {
    vi.useFakeTimers();
    const token = signOverflowAssetToken({ publicId: 'abc123', path: 'a.png' });
    vi.advanceTimersByTime((OVERFLOW_TOKEN_TTL_SECONDS + 1) * 1000);
    expect(verifyOverflowAssetToken(token, 'abc123', 'a.png')).toBe(false);
  });

  it('returns false on garbage without throwing', () => {
    expect(verifyOverflowAssetToken('not-a-jwt', 'abc123', 'a.png')).toBe(false);
    expect(verifyOverflowAssetToken('', 'abc123', 'a.png')).toBe(false);
  });
});

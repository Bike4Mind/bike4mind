// @vitest-environment node
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const secret = vi.hoisted(() => ({ value: 'test-jwt-secret' }));
vi.mock('sst', () => ({ Resource: { JWT_SECRET: secret } }));

import {
  MAX_GENERATED_MEDIA_URL_TOKEN_LENGTH,
  signGeneratedMediaUrlToken,
  verifyGeneratedMediaUrlToken,
} from './generatedMediaUrlToken';

const NOW = 1_800_000_000;
const KEY = 'abc.png';
const token = (over: Partial<{ key: string; exp: number }> = {}) =>
  signGeneratedMediaUrlToken({ key: KEY, exp: NOW + 60, ...over });

describe('generated media url tokens', () => {
  it('verifies a token for the key it was minted for', () => {
    expect(verifyGeneratedMediaUrlToken(token(), KEY, NOW)).toBe(true);
  });

  it('rejects a missing, non-string or oversized token', () => {
    for (const bad of [undefined, null, 42, ['a.b'], '', 'x', 'a.b.c']) {
      expect(verifyGeneratedMediaUrlToken(bad, KEY, NOW)).toBe(false);
    }
    const oversized = `${'a'.repeat(MAX_GENERATED_MEDIA_URL_TOKEN_LENGTH)}.${'A'.repeat(43)}`;
    expect(verifyGeneratedMediaUrlToken(oversized, KEY, NOW)).toBe(false);
  });

  it('rejects a changed payload and a changed mac', () => {
    const [, mac] = token().split('.');
    const forged = Buffer.from(JSON.stringify({ k: KEY, e: NOW + 99_999 })).toString('base64url');
    expect(verifyGeneratedMediaUrlToken(`${forged}.${mac}`, KEY, NOW)).toBe(false);

    const [payload] = token().split('.');
    expect(verifyGeneratedMediaUrlToken(`${payload}.${'A'.repeat(43)}`, KEY, NOW)).toBe(false);
  });

  it('rejects an expired token, including at the expiry second', () => {
    expect(verifyGeneratedMediaUrlToken(token({ exp: NOW }), KEY, NOW)).toBe(false);
    expect(verifyGeneratedMediaUrlToken(token({ exp: NOW + 1 }), KEY, NOW)).toBe(true);
    expect(verifyGeneratedMediaUrlToken(token({ exp: NOW - 1 }), KEY, NOW)).toBe(false);
  });

  it('rejects a token minted for another key', () => {
    expect(verifyGeneratedMediaUrlToken(token({ key: 'other.png' }), KEY, NOW)).toBe(false);
  });

  it('rejects a token minted under the file-link key, a bare JWT-derived key or another key', () => {
    const sign = (key: Buffer) => signGeneratedMediaUrlToken({ key: KEY, exp: NOW + 60 }, key);
    const fileLinkKey = createHmac('sha256', secret.value).update('b4m-file-link-token/v1').digest();
    const bareKey = createHmac('sha256', secret.value).digest();
    for (const key of [fileLinkKey, bareKey, Buffer.from(secret.value), createHmac('sha256', 'other').digest()]) {
      expect(verifyGeneratedMediaUrlToken(sign(key), KEY, NOW)).toBe(false);
    }
  });

  it('rejects correctly signed payloads whose claims are malformed', () => {
    const key = createHmac('sha256', 'claims-key').digest();
    const signRaw = (payload: string) => {
      const body = Buffer.from(payload).toString('base64url');
      return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
    };
    const good = signRaw(JSON.stringify({ k: KEY, e: NOW + 60 }));
    expect(verifyGeneratedMediaUrlToken(good, KEY, NOW, key)).toBe(true);
    const long = 'x'.repeat(1025);
    const bad: [string, string][] = [
      [JSON.stringify({ k: '', e: NOW + 60 }), ''],
      [JSON.stringify({ k: KEY, e: NOW + 60.5 }), KEY],
      [JSON.stringify({ k: KEY, e: String(NOW + 60) }), KEY],
      [JSON.stringify({ k: KEY }), KEY],
      [JSON.stringify({ k: long, e: NOW + 60 }), long],
      ['not json', KEY],
      // Correctly signed and well-formed, but over the token length cap.
      [JSON.stringify({ k: KEY, e: NOW + 60, pad: 'x'.repeat(MAX_GENERATED_MEDIA_URL_TOKEN_LENGTH) }), KEY],
    ];
    for (const [payload, requestedKey] of bad) {
      expect(verifyGeneratedMediaUrlToken(signRaw(payload), requestedKey, NOW, key)).toBe(false);
    }
  });

  it('refuses an empty or placeholder JWT secret for the default key', async () => {
    for (const value of ['', 'change-me']) {
      vi.resetModules();
      secret.value = value;
      const mod = await import('./generatedMediaUrlToken');
      expect(() => mod.signGeneratedMediaUrlToken({ key: KEY, exp: NOW + 60 })).toThrow(/not configured/);
      expect(() => mod.verifyGeneratedMediaUrlToken('a.b', KEY, NOW)).toThrow(/not configured/);
    }
    secret.value = 'test-jwt-secret';
  });
});

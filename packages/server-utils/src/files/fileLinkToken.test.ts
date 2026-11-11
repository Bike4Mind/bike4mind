import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sst', () => ({ Resource: { JWT_SECRET: { value: 'test-jwt-secret' } } }));

import {
  FILE_LINK_PATH,
  buildFileLinkUrl,
  signFileLinkToken,
  verifyFileLinkToken,
  type FileLinkClaims,
} from './fileLinkToken';

const NOW = 1_800_000_000;
const claims: FileLinkClaims = { target: { kind: 'fabFile', fileId: 'f'.repeat(24) }, userId: 'u1', exp: NOW + 60 };

describe('file link tokens', () => {
  it('round-trips every target kind', () => {
    for (const target of [
      claims.target,
      { kind: 'filesKey', key: 'shared-email-files/u1/1-a/x.pdf' },
      { kind: 'generatedKey', key: 'abc.mp4' },
    ] as const) {
      const check = verifyFileLinkToken(signFileLinkToken({ ...claims, target }), NOW);
      expect(check).toEqual({ ok: true, claims: { ...claims, target } });
    }
  });

  it('refuses an expired token', () => {
    expect(verifyFileLinkToken(signFileLinkToken(claims), claims.exp)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a token whose payload was changed', () => {
    const [, mac] = signFileLinkToken(claims).split('.');
    const forged = Buffer.from(JSON.stringify({ t: claims.target, u: 'someone-else', e: claims.exp })).toString(
      'base64url'
    );
    expect(verifyFileLinkToken(`${forged}.${mac}`, NOW).ok).toBe(false);
  });

  it('refuses a token signed with a different key', () => {
    const otherKey = createHmac('sha256', 'other').update('x').digest();
    expect(verifyFileLinkToken(signFileLinkToken(claims, otherKey), NOW).ok).toBe(false);
  });

  it('refuses a token signed directly with the JWT secret', () => {
    expect(verifyFileLinkToken(signFileLinkToken(claims, Buffer.from('test-jwt-secret')), NOW).ok).toBe(false);
  });

  it('refuses malformed input', () => {
    for (const bad of [undefined, 42, '', 'a', 'a.b.c', `${'a'.repeat(5000)}.x`, 'bad!.' + 'a'.repeat(43)]) {
      expect(verifyFileLinkToken(bad, NOW)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses a correctly signed payload with the wrong shape', () => {
    const key = createHmac('sha256', 'test-jwt-secret').update('b4m-file-link-token/v1').digest();
    const payload = Buffer.from(JSON.stringify({ t: { kind: 'other' }, u: 'u1', e: NOW + 60 })).toString('base64url');
    const mac = createHmac('sha256', key).update(payload).digest('base64url');
    expect(verifyFileLinkToken(`${payload}.${mac}`, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('buildFileLinkUrl', () => {
  const original = process.env.APP_URL;
  beforeEach(() => {
    process.env.APP_URL = 'https://app.example.com/';
  });
  afterEach(() => {
    process.env.APP_URL = original;
  });

  it('builds an app URL whose token expires after the TTL', () => {
    const url = buildFileLinkUrl({ kind: 'filesKey', key: 'k' }, 'u1', 300, NOW * 1000);
    const prefix = `https://app.example.com${FILE_LINK_PATH}/`;
    expect(url.startsWith(prefix)).toBe(true);
    const check = verifyFileLinkToken(url.slice(prefix.length), NOW);
    expect(check).toEqual({
      ok: true,
      claims: { target: { kind: 'filesKey', key: 'k' }, userId: 'u1', exp: NOW + 300 },
    });
  });

  it('rejects a non-positive TTL', () => {
    expect(() => buildFileLinkUrl(claims.target, 'u1', 0)).toThrow();
  });
});

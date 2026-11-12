import { describe, expect, it } from 'vitest';
import { canonicalJson, readAccessToken, signAccessToken, stampsDigest } from './modelAccessTokens';

describe('model access tokens', () => {
  it('reads back what it signed', () => {
    const token = signAccessToken({ kind: 'k', exp: 1 });
    expect(readAccessToken(token)).toEqual({ kind: 'k', exp: 1 });
  });

  it('refuses a token whose payload or MAC was altered', () => {
    const [body, mac] = signAccessToken({ actor: 'a' }).split('.');
    const forged = Buffer.from(JSON.stringify({ actor: 'b' })).toString('base64url');
    expect(readAccessToken(`${forged}.${mac}`)).toBeNull();
    expect(readAccessToken(`${body}.${mac.slice(1)}x`)).toBeNull();
    expect(readAccessToken(body)).toBeNull();
  });

  it('binds key order away and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: undefined } })).toBe('{"a":{"d":[2,1]},"b":1}');
  });

  it('digests a different stamp or id set differently', () => {
    const base = stampsDigest([['a', null]]);
    expect(stampsDigest([['a', '2026-11-10T00:00:00.000Z']])).not.toBe(base);
    expect(
      stampsDigest([
        ['a', null],
        ['b', null],
      ])
    ).not.toBe(base);
  });
});

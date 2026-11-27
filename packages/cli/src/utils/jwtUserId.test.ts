import { describe, expect, it } from 'vitest';
import { decodeJwtUserId } from './jwtUserId';

const b64u = (value: unknown) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const header = b64u({ alg: 'HS256', typ: 'JWT' });
const token = (claims: unknown, sig = 'sig') => `${header}.${b64u(claims)}.${sig}`;

describe('decodeJwtUserId', () => {
  it('reads the id claim', () => {
    expect(decodeJwtUserId(token({ id: 'u1' }))).toBe('u1');
    expect(decodeJwtUserId(token({ id: 'abc123', email: 'a@b.c', exp: 1 }))).toBe('abc123');
  });

  it('accepts an unsigned token with an empty signature', () => {
    expect(decodeJwtUserId(`${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ id: 'n1' })}.`)).toBe('n1');
  });

  it('decodes multibyte ids and base64url-only characters', () => {
    expect(decodeJwtUserId(token({ id: '\u00e9\u4e2d\u{1F600}' }))).toBe('\u00e9\u4e2d\u{1F600}');
    expect(decodeJwtUserId(token({ id: '??>>~~' }))).toBe('??>>~~');
  });

  it.each([
    ['no id claim', token({ sub: 's' })],
    ['empty id', token({ id: '' })],
    ['null id', token({ id: null })],
    ['a JSON array payload', token([1, 2])],
    ['a JSON string payload', token('"hello"')],
    ['a JSON null payload', token('null')],
    ['a JSON number payload', token('7')],
  ])('returns an empty id for %s', (_label, jwt) => {
    expect(decodeJwtUserId(jwt)).toBe('');
  });

  it.each([
    ['an empty string', ''],
    ['one segment', 'abc'],
    ['two segments', `${header}.${b64u({ id: 'u1' })}`],
    ['four segments', `${token({ id: 'u1' })}.extra`],
    ['an empty header', `.${b64u({ id: 'u1' })}.sig`],
    ['an empty payload', `${header}..sig`],
    ['a header that is not JSON', `${b64u('nope')}.${b64u({ id: 'u1' })}.sig`],
    ['a header that is JSON null', `${b64u('null')}.${b64u({ id: 'u1' })}.sig`],
    ['a payload that is not JSON', token('not json')],
    ['characters outside base64url', `${header}.@@@.sig`],
    ['padded base64', `${header}.${Buffer.from(JSON.stringify({ id: 'u1' })).toString('base64')}.sig`],
    ['a bearer prefix', `Bearer ${token({ id: 'u1' })}`],
    ['surrounding whitespace', ` ${token({ id: 'u1' })} `],
  ])('rejects %s', (_label, jwt) => {
    expect(decodeJwtUserId(jwt)).toBe('');
  });

  it('ignores a non-string id', () => {
    expect(decodeJwtUserId(token({ id: 5 }))).toBe('');
    expect(decodeJwtUserId(token({ id: { a: 1 } }))).toBe('');
  });
});

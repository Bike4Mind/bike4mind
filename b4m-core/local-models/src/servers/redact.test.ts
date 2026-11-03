import { describe, expect, it } from 'vitest';
import { credentialRedactor } from './redact';

const redact = (credentials: Record<string, string>, text: string) => credentialRedactor(credentials)!.redact(text);

/** Go's encoding/json escapes these for HTML safety. */
const goJson = (value: unknown) =>
  JSON.stringify(value).replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

/** Python's json.dumps with ensure_ascii, the default. */
const pythonJson = (value: unknown) =>
  JSON.stringify(value).replace(/[\u0080-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

describe('credentialRedactor', () => {
  it('is null without a credential', () => {
    expect(credentialRedactor(null)).toBeNull();
    expect(credentialRedactor({})).toBeNull();
  });

  it('redacts the full header value and the token after Bearer', () => {
    const auth = { authorization: 'Bearer tok-secret-zz' };
    expect(redact(auth, 'got Bearer tok-secret-zz, token tok-secret-zz')).toBe('got [redacted], token [redacted]');
  });

  it('redacts a Go-escaped echo, whatever the case of the hex digits', () => {
    const auth = { authorization: 'Bearer tok&en<1>' };
    const body = goJson({ error: 'bad Bearer tok&en<1>' });
    expect(body).toContain('tok\\u0026en\\u003c1\\u003e');
    expect(JSON.parse(redact(auth, body))).toEqual({ error: 'bad [redacted]' });
    expect(redact(auth, 'tok\\u0026EN\\u003C1\\u003E')).toBe('tok\\u0026EN\\u003C1\\u003E');
    expect(redact(auth, 'tok\\u0026en\\u003C1\\u003E')).toBe('[redacted]');
  });

  it('redacts backslash-escaped characters and JSON-escaped quotes', () => {
    const header = { 'x-api-key': 'k/ey"1\\z-long' };
    expect(JSON.parse(redact(header, JSON.stringify({ error: 'k/ey"1\\z-long' })))).toEqual({ error: '[redacted]' });
    expect(redact(header, 'k\\/ey\\"1\\\\z-long')).toBe('[redacted]');
  });

  it('redacts the token after any auth scheme', () => {
    for (const scheme of ['Token', 'Api-Key', 'Digest', 'custom!scheme']) {
      const auth = { authorization: `${scheme} abc123xyz` };
      expect(redact(auth, `{"error":"token abc123xyz unknown"}`)).toBe('{"error":"token [redacted] unknown"}');
    }
  });

  it('redacts Basic credentials decoded, the password alone, and a Python-escaped echo', () => {
    const auth = { authorization: `Basic ${Buffer.from('admin:p\u00e4ss-w0rd').toString('base64')}` };
    expect(redact(auth, 'user admin:p\u00e4ss-w0rd')).toBe('user [redacted]');
    expect(redact(auth, 'password p\u00e4ss-w0rd')).toBe('password [redacted]');
    const body = pythonJson({ error: 'bad password p\u00e4ss-w0rd' });
    expect(body).toContain('p\\u00e4ss-w0rd');
    expect(JSON.parse(redact(auth, body))).toEqual({ error: 'bad password [redacted]' });
  });

  it('matches a short value only as a whole word', () => {
    const org = { 'x-org': 'e' };
    expect(redact(org, '{"error":"model failed to load"}')).toBe('{"error":"model failed to load"}');
    expect(redact(org, '{"error":"org e is unknown"}')).toBe('{"error":"org [redacted] is unknown"}');
    expect(redact(org, '{"error":"org \\u0065 is unknown"}')).toBe('{"error":"org [redacted] is unknown"}');
  });

  it.each([
    ['backspace', '\b'],
    ['tab', '\t'],
    ['newline', '\n'],
    ['form feed', '\f'],
    ['carriage return', '\r'],
  ])('redacts a Basic password containing a JSON-escaped %s', (_name, control) => {
    const password = `pass${control}word`;
    const decoded = `user:${password}`;
    const auth = { authorization: `Basic ${Buffer.from(decoded).toString('base64')}` };
    for (const echoed of [password, decoded]) {
      const body = JSON.stringify({ error: `bad credential ${echoed}` });
      expect(JSON.parse(redact(auth, body))).toEqual({ error: 'bad credential [redacted]' });
      expect(redact(auth, `bad credential ${echoed}`)).toBe('bad credential [redacted]');
    }
  });

  it('reports the longest text a match can span', () => {
    expect(credentialRedactor({ 'x-api-key': 'abcd' })!.longest).toBe(24);
  });
});

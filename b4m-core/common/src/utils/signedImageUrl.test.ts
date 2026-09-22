import { describe, it, expect } from 'vitest';
import { signImageUrl, stripImageUrlSignature, verifyImageUrlSignature } from './signedImageUrl';

const SECRET = 'a-real-test-secret';
const URL_NO_QUERY = 'https://cdn.example.com/watch.jpg';
const URL_WITH_QUERY = 'https://cdn.example.com/watch.jpg?w=400&label=A B'; // deliberately unencoded space

describe('signImageUrl / verifyImageUrlSignature round trip', () => {
  it('a freshly signed URL verifies against the same secret', () => {
    const signed = signImageUrl(URL_NO_QUERY, SECRET);
    expect(verifyImageUrlSignature(signed, SECRET)).toBe(true);
  });

  it('does not verify against a different secret', () => {
    const signed = signImageUrl(URL_NO_QUERY, SECRET);
    expect(verifyImageUrlSignature(signed, 'a-different-secret')).toBe(false);
  });

  it('an unsigned URL never verifies', () => {
    expect(verifyImageUrlSignature(URL_NO_QUERY, SECRET)).toBe(false);
  });

  // Never reparsed through URLSearchParams, which would turn a literal space into "+" and break a
  // presigned CDN link whose own signature covers its exact query string.
  it('preserves an existing query string byte for byte', () => {
    const signed = signImageUrl(URL_WITH_QUERY, SECRET);
    expect(signed.startsWith(URL_WITH_QUERY)).toBe(true);
    expect(verifyImageUrlSignature(signed, SECRET)).toBe(true);
  });

  it('appends with "?" when the URL has no existing query string, "&" when it does', () => {
    expect(signImageUrl(URL_NO_QUERY, SECRET)).toContain('?b4mSig=');
    expect(signImageUrl(URL_WITH_QUERY, SECRET)).toContain('&b4mSig=');
  });

  it('an input that already carries a trailing signature is returned unchanged, not double-signed', () => {
    const signed = signImageUrl(URL_NO_QUERY, SECRET);
    expect(signImageUrl(signed, SECRET)).toBe(signed);
  });

  it('signs a non-URL input as a no-op, and verify rejects it', () => {
    expect(signImageUrl('not a url', SECRET)).toBe('not a url');
    expect(verifyImageUrlSignature('not a url', SECRET)).toBe(false);
  });
});

describe('stripImageUrlSignature', () => {
  it('removes exactly the trailing signature, recovering the original URL', () => {
    expect(stripImageUrlSignature(signImageUrl(URL_NO_QUERY, SECRET))).toBe(URL_NO_QUERY);
    expect(stripImageUrlSignature(signImageUrl(URL_WITH_QUERY, SECRET))).toBe(URL_WITH_QUERY);
  });

  it('is a no-op on a URL with no signature', () => {
    expect(stripImageUrlSignature(URL_NO_QUERY)).toBe(URL_NO_QUERY);
  });
});

describe('verifyImageUrlSignature - tamper resistance', () => {
  // This is the exact bypass an earlier version of this file had: canonicalization deleted every
  // `b4mSig` occurrence while verification read only the first one via `searchParams.get`, so a
  // validly-signed URL with a second, attacker-authored `b4mSig` appended still verified - and the
  // route then forwarded that attacker data to the upstream fetch. The fix anchors the signature to
  // the END of the string and accepts nothing after it.
  it('rejects a second signature-shaped param appended after a valid one', () => {
    const signed = signImageUrl(URL_NO_QUERY, SECRET);
    const tampered = `${signed}&b4mSig=deadbeefdeadbeefdeadbeefdeadbeef`;
    expect(verifyImageUrlSignature(tampered, SECRET)).toBe(false);
  });

  it('rejects any other data appended after a valid signature', () => {
    const signed = signImageUrl(URL_NO_QUERY, SECRET);
    expect(verifyImageUrlSignature(`${signed}&exfil=leaked-data`, SECRET)).toBe(false);
  });

  it('rejects a signature copied onto a different URL', () => {
    const signed = signImageUrl(URL_NO_QUERY, SECRET);
    const signature = /b4mSig=([0-9a-f]{32})$/.exec(signed)?.[1];
    const forged = `https://attacker.example.com/beacon?b4mSig=${signature}`;
    expect(verifyImageUrlSignature(forged, SECRET)).toBe(false);
  });

  it('rejects a signature with one character flipped', () => {
    const signed = signImageUrl(URL_NO_QUERY, SECRET);
    const flipped = signed.slice(0, -1) + (signed.endsWith('0') ? '1' : '0');
    expect(verifyImageUrlSignature(flipped, SECRET)).toBe(false);
  });
});

describe('verifyImageUrlSignature - unconfigured/placeholder secret fails closed', () => {
  // A deploy that never overrides the SST secret's declared default (infra/secrets.ts) must not
  // have every signature accept-anything under that well-known value.
  const PLACEHOLDER = 'my-secret-placeholder-value';

  it('rejects even a URL that was itself signed with the placeholder secret', () => {
    const signed = signImageUrl(URL_NO_QUERY, PLACEHOLDER);
    expect(verifyImageUrlSignature(signed, PLACEHOLDER)).toBe(false);
  });

  it('rejects when the secret is an empty string', () => {
    const signed = signImageUrl(URL_NO_QUERY, '');
    expect(verifyImageUrlSignature(signed, '')).toBe(false);
  });

  it('rejects the "not-configured" sentinel used elsewhere in the codebase for this same secret', () => {
    const signed = signImageUrl(URL_NO_QUERY, 'not-configured');
    expect(verifyImageUrlSignature(signed, 'not-configured')).toBe(false);
  });
});

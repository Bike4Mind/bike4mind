import { describe, expect, it } from 'vitest';
import { fileContentExp, mintFileContentSig, verifyFileContentSig } from './fileContentToken';
import { FILE_URL_TTL_SECONDS, FILE_URL_WINDOW_SECONDS } from './signedUrlWindow';

const key = Buffer.alloc(32, 7);
const fileId = '0123456789abcdef01234567';
const filePath = 'uploads/u1/photo.png';
const now = 1_800_000_000;
const exp = now + 600;

const verify = (over: Partial<Record<'fileId' | 'filePath' | 'exp' | 'sig', unknown>> = {}, at = now) =>
  verifyFileContentSig(
    { fileId, filePath, exp: String(exp), sig: mintFileContentSig({ fileId, filePath, exp }, key), ...over },
    key,
    at
  );

describe('fileContentToken', () => {
  it('round trips', () => {
    expect(verify()).toEqual({ ok: true, exp });
  });

  it('rejects a tampered sig', () => {
    const sig = mintFileContentSig({ fileId, filePath, exp }, key);
    const tampered = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(verify({ sig: tampered })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects another key', () => {
    const sig = mintFileContentSig({ fileId, filePath, exp }, Buffer.alloc(32, 8));
    expect(verify({ sig })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a different file id or file path', () => {
    expect(verify({ fileId: '0123456789abcdef01234568' })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verify({ filePath: 'uploads/u1/other.png' })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a changed exp', () => {
    expect(verify({ exp: String(exp + 1) })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an expired link after checking the MAC', () => {
    expect(verify({}, exp)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects malformed input', () => {
    for (const over of [
      { exp: '0600' },
      { exp: '-5' },
      { exp: '1e9' },
      { exp: undefined },
      { sig: 'short' },
      { sig: ['a'] },
      { sig: `${'a'.repeat(42)}=` },
      { fileId: 'not-an-id' },
      { filePath: '' },
    ]) {
      expect(verify(over)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('mints identical links for two reads in the same window', () => {
    const start = Date.UTC(2026, 0, 1, 10, 30, 0);
    const a = fileContentExp(new Date(start + 1000));
    const b = fileContentExp(new Date(start + FILE_URL_WINDOW_SECONDS * 1000 - 1));
    expect(a).toBe(b);
    expect(a).toBe(start / 1000 + FILE_URL_TTL_SECONDS);
    expect(mintFileContentSig({ fileId, filePath, exp: a }, key)).toBe(
      mintFileContentSig({ fileId, filePath, exp: b }, key)
    );
  });
});

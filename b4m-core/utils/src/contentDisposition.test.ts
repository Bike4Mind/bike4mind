import { describe, expect, it } from 'vitest';
import { buildContentDisposition, isInlineSafeMimeType } from './contentDisposition';

describe('isInlineSafeMimeType', () => {
  it('inlines raster images but never svg', () => {
    expect(isInlineSafeMimeType('image/png')).toBe(true);
    expect(isInlineSafeMimeType('image/svg+xml')).toBe(false);
  });

  it('inlines the allowlisted document types and refuses everything else', () => {
    expect(isInlineSafeMimeType('application/pdf')).toBe(true);
    expect(isInlineSafeMimeType('text/markdown')).toBe(true);
    expect(isInlineSafeMimeType('text/html')).toBe(false);
    expect(isInlineSafeMimeType('application/octet-stream')).toBe(false);
    expect(isInlineSafeMimeType(null)).toBe(false);
  });

  it('ignores parameters and casing on the media type', () => {
    expect(isInlineSafeMimeType('TEXT/CSV; charset=utf-8')).toBe(true);
  });
});

describe('buildContentDisposition', () => {
  it('defaults to attachment', () => {
    expect(buildContentDisposition('report.pdf')).toBe('attachment; filename="report.pdf"');
  });

  it('resolves auto against the mime type', () => {
    expect(buildContentDisposition('a.png', { disposition: 'auto', mimeType: 'image/png' })).toBe(
      'inline; filename="a.png"'
    );
    expect(buildContentDisposition('a.svg', { disposition: 'auto', mimeType: 'image/svg+xml' })).toBe(
      'attachment; filename="a.svg"'
    );
    expect(buildContentDisposition('a.bin', { disposition: 'auto' })).toBe('attachment; filename="a.bin"');
  });

  it('neutralizes quotes and backslashes that would break out of the quoted-string', () => {
    expect(buildContentDisposition('evil".pdf')).toBe('attachment; filename="evil_.pdf"');
    expect(buildContentDisposition('back\\slash.pdf')).toBe('attachment; filename="back_slash.pdf"');
  });

  it('strips CR/LF so a filename cannot inject a header', () => {
    const header = buildContentDisposition('a\r\nX-Injected: 1.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toBe('attachment; filename="a__X-Injected: 1.pdf"');
  });

  it('adds an RFC 5987 filename* for non-ASCII names, keeping an ASCII fallback', () => {
    expect(buildContentDisposition('resum\u00e9.pdf')).toBe(
      'attachment; filename="resum_.pdf"; filename*=UTF-8\'\'resum%C3%A9.pdf'
    );
  });

  it('omits filename* for pure-ASCII names', () => {
    expect(buildContentDisposition('plain.pdf')).not.toContain('filename*');
  });

  it('percent-encodes the characters encodeURIComponent leaves alone', () => {
    expect(buildContentDisposition("n\u00e4me'(a)*.pdf")).toContain("filename*=UTF-8''n%C3%A4me%27%28a%29%2A.pdf");
  });

  it('truncates long names in both parameters', () => {
    const header = buildContentDisposition(`${'a'.repeat(300)}.pdf`);
    expect(header).toBe(`attachment; filename="${'a'.repeat(150)}"`);
  });

  it('falls back to a placeholder when nothing printable survives', () => {
    expect(buildContentDisposition('   ')).toBe('attachment; filename="download"');
    expect(buildContentDisposition('')).toBe('attachment; filename="download"');
  });
});

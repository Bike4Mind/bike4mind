import { describe, expect, it } from 'vitest';
import { buildContentDisposition, storageReadOverrides } from './contentDisposition';

const E_ACUTE = String.fromCharCode(0xe9); // e-acute, e.g. resume with an accent
const A_DIAERESIS = String.fromCharCode(0xe4); // a-diaeresis
const NEL = String.fromCharCode(0x85); // C1 control char (Next Line)

describe('buildContentDisposition', () => {
  it('defaults to attachment', () => {
    expect(buildContentDisposition('report.pdf')).toBe('attachment; filename="report.pdf"');
  });

  it('honors an explicit inline disposition', () => {
    expect(buildContentDisposition('report.pdf', { disposition: 'inline' })).toBe('inline; filename="report.pdf"');
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

  it('scrubs C1 control characters (non-ASCII) so they cannot survive into filename*', () => {
    const header = buildContentDisposition(`bad${NEL}name.pdf`);
    expect(header).toBe('attachment; filename="bad_name.pdf"');
    expect(header).not.toContain('filename*');
  });

  it('adds an RFC 5987 filename* for non-ASCII names, keeping an ASCII fallback', () => {
    expect(buildContentDisposition(`resum${E_ACUTE}.pdf`)).toBe(
      'attachment; filename="resum_.pdf"; filename*=UTF-8\'\'resum%C3%A9.pdf'
    );
  });

  it('omits filename* for pure-ASCII names', () => {
    expect(buildContentDisposition('plain.pdf')).not.toContain('filename*');
  });

  it('percent-encodes the characters encodeURIComponent leaves alone', () => {
    expect(buildContentDisposition(`n${A_DIAERESIS}me'(a)*.pdf`)).toContain(
      "filename*=UTF-8''n%C3%A4me%27%28a%29%2A.pdf"
    );
  });

  it('truncates long names, preserving the extension, in both parameters', () => {
    const header = buildContentDisposition(`${E_ACUTE}${'a'.repeat(300)}.docx`);
    expect(header).toContain(`filename="_${'a'.repeat(144)}.docx"`);
    expect(header).toContain("filename*=UTF-8''%C3%A9");
    expect(header).toContain('.docx');
  });

  it('does not throw when truncation lands inside a surrogate pair', () => {
    const surrogateHeavy = 'a' + '\u{1F600}'.repeat(150) + '.pdf';
    expect(() => buildContentDisposition(surrogateHeavy)).not.toThrow();
    const header = buildContentDisposition(surrogateHeavy);
    expect(header).toContain('filename*=');
  });

  it('falls back to a placeholder when nothing printable survives', () => {
    expect(buildContentDisposition('   ')).toBe('attachment; filename="download"');
    expect(buildContentDisposition('')).toBe('attachment; filename="download"');
  });
});

describe('storageReadOverrides', () => {
  it.each(['image/png', 'image/jpeg', 'application/pdf', 'video/mp4', 'audio/mpeg'])(
    'serves %s inline with a pinned content type',
    mimeType => {
      expect(storageReadOverrides({ mimeType, fileName: 'a', key: 'k/a' })).toEqual({ ResponseContentType: mimeType });
    }
  );

  it('normalizes case, whitespace and parameters before deciding', () => {
    expect(storageReadOverrides({ mimeType: ' Image/PNG; foo=bar ', fileName: 'a.png' })).toEqual({
      ResponseContentType: 'image/png',
    });
  });

  it.each([
    'text/html',
    'Text/HTML; charset=utf-8',
    'image/svg+xml',
    'application/xhtml+xml',
    'application/xml',
    'text/xml',
    'text/plain',
    'text/javascript',
    'application/octet-stream',
    '',
    undefined,
    null,
  ])('forces %s to download as an attachment', mimeType => {
    expect(storageReadOverrides({ mimeType, fileName: 'page.html', key: 'u/1/page.html' })).toEqual({
      ResponseContentDisposition: 'attachment; filename="page.html"',
    });
  });

  it('falls back to the key segment, then to a generic name, when the file has no name', () => {
    expect(storageReadOverrides({ mimeType: 'text/html', fileName: '', key: 'modals/banner.html' })).toEqual({
      ResponseContentDisposition: 'attachment; filename="banner.html"',
    });
    expect(storageReadOverrides({ mimeType: 'text/html' })).toEqual({
      ResponseContentDisposition: 'attachment; filename="download"',
    });
  });

  it('sanitizes a hostile filename through buildContentDisposition', () => {
    const { ResponseContentDisposition } = storageReadOverrides({
      mimeType: 'text/html',
      fileName: `x"\r\nSet-Cookie: a=b; r${E_ACUTE}sum${E_ACUTE}.html`,
    });
    expect(ResponseContentDisposition).not.toMatch(/[\r\n]/);
    expect(ResponseContentDisposition).toBe(
      `attachment; filename="x___Set-Cookie: a=b; r_sum_.html"; filename*=UTF-8''x%22__Set-Cookie%3A%20a%3Db%3B%20r%C3%A9sum%C3%A9.html`
    );
  });

  it('truncates a very long filename', () => {
    const { ResponseContentDisposition } = storageReadOverrides({
      mimeType: 'text/html',
      fileName: `${'a'.repeat(200)}.html`,
    });
    expect(ResponseContentDisposition).toBe(`attachment; filename="${'a'.repeat(145)}.html"`);
  });
});

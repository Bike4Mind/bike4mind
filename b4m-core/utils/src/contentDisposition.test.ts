import { describe, expect, it } from 'vitest';
import { buildContentDisposition } from './contentDisposition';

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

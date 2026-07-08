import { describe, it, expect } from 'vitest';
import { sanitizeHtmlForIframe } from './htmlSanitizer';

/**
 * End-to-end sanitizer behavior against the REAL DOMPurify (this file does not
 * mock it, unlike htmlSanitizer.test.ts which asserts the config object).
 *
 * Guards the regression where DOMPurify's SAFE_FOR_XML mXSS heuristic
 * (/<[/\w!]/ over raw-text nodes) force-removed any <script> containing a `<`
 * glued to a word char - i.e. ordinary JS like `for(i=0;i<n;i++)` - leaving
 * interactive HTML artifacts rendered but inert.
 */
describe('sanitizeHtmlForIframe (real DOMPurify)', () => {
  const scriptDoc = (js: string) =>
    `<!DOCTYPE html><html><body><canvas id="c"></canvas><script>${js}</script></body></html>`;

  // `<` glued to a word char/digit - the exact shape that tripped the guard.
  const comparisonJs = 'for(var i=0;i<TOTAL;i++){} if(g.x<0){} for(var i=0;i<grains.length;i++){}';

  it('keeps a <script> whose body uses `<` comparisons when allowScripts is true', () => {
    const { cleanHtml } = sanitizeHtmlForIframe(scriptDoc(comparisonJs), { allowScripts: true });
    expect(cleanHtml).toContain('<script');
    expect(cleanHtml).toContain('i<TOTAL');
    expect(cleanHtml).toContain('g.x<0');
  });

  it('still strips <script> entirely when allowScripts is omitted', () => {
    const { cleanHtml } = sanitizeHtmlForIframe(scriptDoc(comparisonJs));
    expect(cleanHtml).not.toContain('<script');
  });

  it('still strips iframe/object/embed even with scripts allowed', () => {
    const dirty =
      '<!DOCTYPE html><html><body><script>var a=1<2;</script>' +
      '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="y"></body></html>';
    const { cleanHtml } = sanitizeHtmlForIframe(dirty, { allowScripts: true });
    expect(cleanHtml).toContain('<script');
    expect(cleanHtml).not.toContain('<iframe');
    expect(cleanHtml).not.toContain('<object');
    expect(cleanHtml).not.toContain('<embed');
  });

  it('still strips inline event-handler attributes with scripts allowed', () => {
    const dirty = '<!DOCTYPE html><html><body><div onclick="steal()">x</div><script>var a=1<2;</script></body></html>';
    const { cleanHtml } = sanitizeHtmlForIframe(dirty, { allowScripts: true });
    expect(cleanHtml).not.toContain('onclick');
  });
});

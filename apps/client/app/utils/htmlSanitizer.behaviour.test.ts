// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeHtmlStrict, sanitizeHtmlForIframe } from './htmlSanitizer';

// Real DOMPurify (NOT the identity mock in htmlSanitizer.test.ts): these assert the strict
// policy actually strips tags, so an empty STRICT_FORBID_TAGS would fail here. This is the
// behaviour DOCXViewer.tsx and ResearchTasks/Detail.tsx rely on - app-origin sinks with no
// sandbox iframe, where injected <style>/<link> would apply to the app origin.
describe('sanitizeHtmlStrict (real DOMPurify)', () => {
  it('strips <style> but keeps the surrounding content', () => {
    const out = sanitizeHtmlStrict('<style>body{display:none}</style><p>hello</p>');
    expect(out).not.toMatch(/<style/i);
    expect(out).not.toContain('display:none');
    expect(out).toContain('hello');
  });

  it('strips <link> (no external stylesheet load)', () => {
    const out = sanitizeHtmlStrict('<link rel="stylesheet" href="https://evil.test/x.css"><p>ok</p>');
    expect(out).not.toMatch(/<link/i);
    expect(out).toContain('ok');
  });

  it('strips <script>', () => {
    const out = sanitizeHtmlStrict('<p>ok</p><script>alert(1)</script>');
    expect(out).not.toMatch(/<script/i);
  });

  it('keeps inline style="" attributes (mammoth uses them for layout)', () => {
    const out = sanitizeHtmlStrict('<p style="text-align:center">centered</p>');
    expect(out).toMatch(/style=/i);
    expect(out).toContain('centered');
  });

  // Contrast: the iframe-tuned sanitizer deliberately re-admits <style> in a whole document (its
  // sandbox is the boundary). The strict one strips it regardless - that difference is the point of B2.
  it('differs from sanitizeHtmlForIframe, which keeps <style> in a whole document', () => {
    const doc = '<!doctype html><html><head><style>p{color:red}</style></head><body><p>x</p></body></html>';
    expect(sanitizeHtmlForIframe(doc).cleanHtml).toMatch(/<style/i);
    expect(sanitizeHtmlStrict(doc)).not.toMatch(/<style/i);
  });
});

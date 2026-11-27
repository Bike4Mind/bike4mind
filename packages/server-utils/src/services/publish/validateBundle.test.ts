import { describe, it, expect } from 'vitest';
import { validateBundle } from './validateBundle';

const manifest = (paths: string[]) => paths.map(p => ({ path: p, mimeType: 'text/plain' }));

describe('validateBundle', () => {
  it('passes a clean bundle (relative assets resolve to manifest)', () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="assets/style.css">
    </head><body><img src="assets/logo.png"><script>console.log('ok')</script></body></html>`;
    const r = validateBundle({ indexHtml: html, manifest: manifest(['assets/style.css', 'assets/logo.png']) });
    expect(r.valid).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('rejects eval() in an inline script', () => {
    const r = validateBundle({ indexHtml: `<script>eval("x")</script>`, manifest: [] });
    expect(r.valid).toBe(false);
    expect(r.violations.some(v => v.type === 'forbidden_pattern')).toBe(true);
  });

  it('rejects new Function() and string-form setTimeout', () => {
    const r1 = validateBundle({ indexHtml: `<script>new Function('return 1')</script>`, manifest: [] });
    expect(r1.violations.some(v => v.type === 'forbidden_pattern')).toBe(true);
    const r2 = validateBundle({ indexHtml: `<script>setTimeout("alert(1)", 10)</script>`, manifest: [] });
    expect(r2.violations.some(v => v.type === 'forbidden_pattern')).toBe(true);
  });

  it('rejects iframes', () => {
    const r = validateBundle({ indexHtml: `<iframe src="https://evil.tld"></iframe>`, manifest: [] });
    expect(r.violations.some(v => v.type === 'forbidden_iframe')).toBe(true);
  });

  it('rejects meta-refresh redirects and <base> (anti-phishing)', () => {
    const r1 = validateBundle({
      indexHtml: `<meta http-equiv="refresh" content="0;url=https://evil.tld">`,
      manifest: [],
    });
    expect(r1.valid).toBe(false);
    expect(r1.violations.some(v => /refresh/i.test(v.message))).toBe(true);

    const r2 = validateBundle({ indexHtml: `<base href="https://evil.tld/">`, manifest: [] });
    expect(r2.violations.some(v => /base/i.test(v.message))).toBe(true);
  });

  it('rejects a non-allowlisted <script src>', () => {
    const r = validateBundle({ indexHtml: `<script src="https://cdn.evil.tld/x.js"></script>`, manifest: [] });
    expect(r.violations.some(v => v.type === 'csp_violation')).toBe(true);
  });

  it('allows the blessed same-origin chart lib', () => {
    const r = validateBundle({
      indexHtml: `<script src="/static/lib/chart.js@4.x.js"></script>`,
      manifest: [],
    });
    expect(r.valid).toBe(true);
  });

  it('rejects a relative asset missing from the manifest', () => {
    const r = validateBundle({ indexHtml: `<img src="missing.png">`, manifest: manifest(['present.png']) });
    expect(r.violations.some(v => v.type === 'invalid_asset_url')).toBe(true);
  });

  it('allows Google Fonts stylesheet host but rejects a suffix-attack host', () => {
    const ok = validateBundle({
      indexHtml: `<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Inter">`,
      manifest: [],
    });
    expect(ok.valid).toBe(true);

    const bad = validateBundle({
      indexHtml: `<link rel="stylesheet" href="https://fonts.googleapis.com.evil.tld/x.css">`,
      manifest: [],
    });
    expect(bad.violations.some(v => v.type === 'csp_violation')).toBe(true);
  });

  it('allows data: URLs for assets', () => {
    const r = validateBundle({
      indexHtml: `<img src="data:image/png;base64,iVBORw0KGgo=">`,
      manifest: [],
    });
    expect(r.valid).toBe(true);
  });
});

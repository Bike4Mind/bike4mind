import { describe, it, expect } from 'vitest';
import { isBundlePagePath, renderSandboxedBundle, resolveBundlePath, type SandboxAsset } from './renderSandboxedBundle';

const ORIGIN = 'https://app.bike4mind.com';
const URL_BASE = '/p/u/scope123/my-slug';

const asset = (s: string, mimeType = 'text/plain'): SandboxAsset => ({ data: Buffer.from(s), mimeType });

describe('renderSandboxedBundle', () => {
  it('preserves author inline <script> (the core re-enable)', () => {
    const html = `<!doctype html><html><head></head><body><script>console.log('hi')</script></body></html>`;
    const { srcdoc } = renderSandboxedBundle({
      indexHtml: html,
      urlBase: URL_BASE,
      origin: ORIGIN,
      visibility: 'public',
    });
    expect(srcdoc).toContain(`console.log('hi')`);
  });

  it('absolutizes blessed library scripts to the app origin', () => {
    const html = `<html><head><script src="/static/lib/chart.js@4.x.js"></script></head><body></body></html>`;
    const { srcdoc } = renderSandboxedBundle({
      indexHtml: html,
      urlBase: URL_BASE,
      origin: ORIGIN,
      visibility: 'public',
    });
    expect(srcdoc).toContain(`src="${ORIGIN}/static/lib/chart.js@4.x.js"`);
  });

  describe('public', () => {
    it('injects a <base href> at the bundle path and keeps relative refs relative', () => {
      const html = `<html><head></head><body><img src="assets/logo.png"></body></html>`;
      const { srcdoc, droppedAssets } = renderSandboxedBundle({
        indexHtml: html,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'public',
      });
      expect(srcdoc).toContain(`<base href="${ORIGIN}${URL_BASE}/">`);
      expect(srcdoc).toContain(`src="assets/logo.png"`);
      expect(droppedAssets).toHaveLength(0);
    });

    it('updates an author-supplied <base> rather than adding a second one', () => {
      const html = `<html><head><base href="https://evil.tld/"></head><body></body></html>`;
      const { srcdoc } = renderSandboxedBundle({
        indexHtml: html,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'public',
      });
      expect(srcdoc).not.toContain('evil.tld');
      expect(srcdoc.match(/<base/g) ?? []).toHaveLength(1);
      expect(srcdoc).toContain(`<base href="${ORIGIN}${URL_BASE}/">`);
    });

    it('does not inline assets for public bundles', () => {
      const html = `<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>`;
      const assets = new Map([['style.css', asset('body{color:red}', 'text/css')]]);
      const { srcdoc } = renderSandboxedBundle({
        indexHtml: html,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'public',
        assets,
      });
      expect(srcdoc).toContain(`href="style.css"`);
      expect(srcdoc).not.toContain('body{color:red}');
    });
  });

  describe('gated', () => {
    it('inlines a relative image as a data: URI', () => {
      const html = `<html><body><img src="logo.png"></body></html>`;
      const assets = new Map([['logo.png', asset('PNGDATA', 'image/png')]]);
      const { srcdoc, droppedAssets } = renderSandboxedBundle({
        indexHtml: html,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'private',
        assets,
      });
      expect(srcdoc).toContain(`data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`);
      expect(srcdoc).not.toContain('src="logo.png"');
      expect(droppedAssets).toHaveLength(0);
    });

    it('inlines a relative stylesheet as an inline <style> block', () => {
      const html = `<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>`;
      const assets = new Map([['style.css', asset('body{color:red}', 'text/css')]]);
      const { srcdoc } = renderSandboxedBundle({
        indexHtml: html,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'organization',
        assets,
      });
      expect(srcdoc).toContain('<style>body{color:red}</style>');
      expect(srcdoc).not.toContain('<link');
    });

    it('does not inject a <base> for gated bundles', () => {
      const html = `<html><head></head><body></body></html>`;
      const { srcdoc } = renderSandboxedBundle({
        indexHtml: html,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'project',
      });
      expect(srcdoc).not.toContain('<base');
    });

    it('reports a missing asset in droppedAssets and removes a missing stylesheet', () => {
      const html = `<html><head><link rel="stylesheet" href="missing.css"></head><body><img src="missing.png"></body></html>`;
      const { srcdoc, droppedAssets } = renderSandboxedBundle({
        indexHtml: html,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'private',
        assets: new Map(),
      });
      expect(droppedAssets).toContain('missing.css');
      expect(droppedAssets).toContain('missing.png');
      expect(srcdoc).not.toContain('<link');
    });

    it('leaves data: and absolute URLs untouched', () => {
      const html = `<html><body><img src="data:image/png;base64,AAAA"><img src="https://app.bike4mind.com/x.png"></body></html>`;
      const { srcdoc, droppedAssets } = renderSandboxedBundle({
        indexHtml: html,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'private',
        assets: new Map(),
      });
      expect(srcdoc).toContain('data:image/png;base64,AAAA');
      expect(srcdoc).toContain('https://app.bike4mind.com/x.png');
      expect(droppedAssets).toHaveLength(0);
    });
  });

  describe('assetMode override (share links)', () => {
    const SHARE_BASE = '/a/tok123';

    it("forces the <base> model for a PRIVATE bundle when assetMode:'base' (no inlining)", () => {
      const html = `<html><head></head><body><img src="logo.png"></body></html>`;
      const { srcdoc, droppedAssets } = renderSandboxedBundle({
        indexHtml: html,
        urlBase: SHARE_BASE,
        origin: ORIGIN,
        visibility: 'private',
        assetMode: 'base',
      });
      // <base> at the share path so assets resolve through /a/<token>/... and self-authorize.
      expect(srcdoc).toContain(`<base href="${ORIGIN}${SHARE_BASE}/">`);
      expect(srcdoc).toContain('src="logo.png"'); // left relative, NOT inlined
      expect(srcdoc).not.toContain('data:image');
      expect(droppedAssets).toHaveLength(0);
    });

    it("still inlines a PRIVATE bundle when assetMode:'inline'", () => {
      const html = `<html><head></head><body><img src="logo.png"></body></html>`;
      const { srcdoc } = renderSandboxedBundle({
        indexHtml: html,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'private',
        assetMode: 'inline',
        assets: new Map([['logo.png', asset('PNG', 'image/png')]]),
      });
      expect(srcdoc).toContain(`data:image/png;base64,${Buffer.from('PNG').toString('base64')}`);
      expect(srcdoc).not.toContain('<base');
    });

    it('default (no assetMode) preserves visibility-derived behavior', () => {
      const html = `<html><head></head><body></body></html>`;
      const pub = renderSandboxedBundle({ indexHtml: html, urlBase: URL_BASE, origin: ORIGIN, visibility: 'public' });
      expect(pub.srcdoc).toContain('<base');
      const priv = renderSandboxedBundle({
        indexHtml: html,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'private',
        assets: new Map(),
      });
      expect(priv.srcdoc).not.toContain('<base');
    });
  });

  describe('off-origin links', () => {
    const render = (body: string) =>
      renderSandboxedBundle({
        indexHtml: `<html><head></head><body>${body}</body></html>`,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'public',
      }).srcdoc;

    it('retargets an off-origin link to a new tab with rel=noopener', () => {
      const srcdoc = render(`<a href="https://github.com/o/r/issues/1">issue</a>`);
      expect(srcdoc).toContain('target="_blank"');
      expect(srcdoc).toContain('rel="noopener"');
    });

    it('keeps the author rel tokens and does not add noreferrer', () => {
      const srcdoc = render(`<a href="https://example.com/" rel="nofollow">x</a>`);
      expect(srcdoc).toContain('rel="nofollow noopener"');
      expect(srcdoc).not.toContain('noreferrer');
    });

    it('retargets a protocol-relative off-origin link', () => {
      const srcdoc = render(`<a href="//example.com/x">x</a>`);
      expect(srcdoc).toContain('target="_blank"');
    });

    it('leaves same-origin, relative, fragment and non-http links alone', () => {
      const srcdoc = render(
        `<a href="${ORIGIN}/p/u/s/other">a</a><a href="page2.html">b</a><a href="#tldr">c</a>` +
          `<a href="mailto:x@example.com">d</a>`
      );
      expect(srcdoc).not.toContain('target="_blank"');
      expect(srcdoc).not.toContain('rel="noopener"');
    });
  });

  describe('fragment-nav helper', () => {
    const html = `<html><head></head><body><a href="#tldr">jump</a></body></html>`;

    it('injects the helper with the doc origin and page paths when pagePaths is set', () => {
      const { srcdoc } = renderSandboxedBundle({
        indexHtml: html,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'private',
        assets: new Map(),
        pagePaths: [URL_BASE, '/a/tok123'],
      });
      expect(srcdoc).toContain(`"paths":["${URL_BASE}","/a/tok123"]`);
      expect(srcdoc).toContain(`"origins":["${ORIGIN}"`);
      expect(srcdoc).toContain(`b4m:'fragment'`);
    });

    it('does not inject the helper when pagePaths is omitted (?a= sub-documents)', () => {
      const { srcdoc } = renderSandboxedBundle({
        indexHtml: html,
        urlBase: '',
        origin: ORIGIN,
        visibility: 'public',
        assetMode: 'inline',
      });
      expect(srcdoc).not.toContain(`b4m:'fragment'`);
    });
  });

  describe('print bridge', () => {
    it('appends the bridge after author content, inside the body', () => {
      const html = `<html><head></head><body><h1 id="last">Hi</h1></body></html>`;
      const { srcdoc } = renderSandboxedBundle({
        indexHtml: html,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'public',
      });
      expect(srcdoc).toContain(`b4m==='print'`);
      expect(srcdoc.indexOf(`b4m==='print'`)).toBeGreaterThan(srcdoc.indexOf('id="last"'));
      expect(srcdoc.indexOf(`b4m==='print'`)).toBeLessThan(srcdoc.indexOf('</body>'));
    });

    it('rides along on every render - gated, ?a= sub-document, and the ?export=html download', () => {
      const html = `<html><head></head><body><h1>Hi</h1></body></html>`;
      const gated = renderSandboxedBundle({
        indexHtml: html,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'private',
        assets: new Map(),
        pagePaths: [URL_BASE],
      });
      const subDoc = renderSandboxedBundle({
        indexHtml: html,
        urlBase: '',
        origin: ORIGIN,
        visibility: 'public',
        assetMode: 'inline',
      });
      expect(gated.srcdoc).toContain('print-color-adjust');
      expect(subDoc.srcdoc).toContain('print-color-adjust');
    });

    it('still lands when the author ships a bare fragment rather than a document', () => {
      const { srcdoc } = renderSandboxedBundle({
        indexHtml: `<h1>Hi</h1>`,
        urlBase: URL_BASE,
        origin: ORIGIN,
        visibility: 'public',
      });
      expect(srcdoc).toContain('window.print');
    });
  });
});

describe('resolveBundlePath', () => {
  it.each([
    ['index.html', 'style.css', 'style.css'],
    ['index.html', './img/a.png', 'img/a.png'],
    ['guide/intro.html', 'figure.png', 'guide/figure.png'],
    ['guide/intro.html', '../index.html', 'index.html'],
    ['guide/intro.html', '../files/report.pdf?x=1#p2', 'files/report.pdf'],
    ['index.html', 'my%20file.pdf', 'my file.pdf'],
    ['index.html', '', 'index.html'],
  ])('resolves %s + %s to %s', (page, ref, expected) => {
    expect(resolveBundlePath(page, ref)).toBe(expected);
  });

  it.each([
    ['index.html', '../escape.html'],
    ['guide/intro.html', '../../escape.html'],
    ['index.html', '//other.example/x'],
  ])('rejects %s + %s, which leaves the bundle', (page, ref) => {
    expect(resolveBundlePath(page, ref)).toBeNull();
  });
});

describe('isBundlePagePath', () => {
  it.each([
    ['index.html', true],
    ['guide/Intro.HTM', true],
    ['figure.svg', false],
    ['page.xhtml', false],
    ['page.html.txt', false],
  ])('%s -> %s', (path, expected) => {
    expect(isBundlePagePath(path)).toBe(expected);
  });
});

describe('renderSandboxedBundle - multi-page bundles', () => {
  const page = `<html><head></head><body><img src="figure.png"><a href="../index.html#top">Home</a>
<a href="../files/report.pdf">Report</a><a href="next.html" target="_blank">Next</a><a href="#local">Here</a>
<a href="../../outside.html">Out</a></body></html>`;

  it('bases a public sub-page at its own directory', () => {
    const { srcdoc } = renderSandboxedBundle({
      indexHtml: page,
      urlBase: URL_BASE,
      origin: ORIGIN,
      visibility: 'public',
      pagePath: 'guide/intro.html',
    });
    expect(srcdoc).toContain(`<base href="${ORIGIN}${URL_BASE}/guide/">`);
  });

  it('inlines page-relative assets and absolutizes same-bundle links in gated mode', () => {
    const { srcdoc, droppedAssets } = renderSandboxedBundle({
      indexHtml: page,
      urlBase: URL_BASE,
      origin: ORIGIN,
      visibility: 'private',
      pagePath: 'guide/intro.html',
      assets: new Map([['guide/figure.png', asset('PNG', 'image/png')]]),
    });
    expect(droppedAssets).toHaveLength(0);
    expect(srcdoc).toContain(`src="data:image/png;base64,${Buffer.from('PNG').toString('base64')}"`);
    expect(srcdoc).toContain(`href="${ORIGIN}${URL_BASE}#top"`);
    expect(srcdoc).toContain(`href="${ORIGIN}${URL_BASE}/files/report.pdf"`);
    expect(srcdoc).toContain(`href="${ORIGIN}${URL_BASE}/guide/next.html" target="_blank"`);
    // Fragment-only links and links that leave the bundle are untouched.
    expect(srcdoc).toContain('href="#local"');
    expect(srcdoc).toContain('href="../../outside.html"');
  });

  it("keeps a file link's exact ?download=1 and drops every other query", () => {
    const { srcdoc } = renderSandboxedBundle({
      indexHtml:
        '<html><body><a href="files/deck.pdf?download=1">Get</a><a href="files/deck.pdf?download=1#p2">Get p2</a>' +
        '<a href="files/deck.pdf?download=1&x=2">Other</a><a href="next.html?download=1">Page</a>' +
        '<a href="next.html?tab=2#s">Tab</a></body></html>',
      urlBase: URL_BASE,
      origin: ORIGIN,
      visibility: 'private',
    });
    expect(srcdoc).toContain(`href="${ORIGIN}${URL_BASE}/files/deck.pdf?download=1"`);
    expect(srcdoc).toContain(`href="${ORIGIN}${URL_BASE}/files/deck.pdf?download=1#p2"`);
    expect(srcdoc).toContain(`href="${ORIGIN}${URL_BASE}/files/deck.pdf">Other`);
    expect(srcdoc).toContain(`href="${ORIGIN}${URL_BASE}/next.html">Page`);
    expect(srcdoc).toContain(`href="${ORIGIN}${URL_BASE}/next.html#s">Tab`);
  });

  it('also fixes index links in gated mode, which have no <base> to resolve against', () => {
    const { srcdoc } = renderSandboxedBundle({
      indexHtml: '<html><body><a href="poster/poster.html">Poster</a></body></html>',
      urlBase: URL_BASE,
      origin: ORIGIN,
      visibility: 'private',
    });
    expect(srcdoc).toContain(`href="${ORIGIN}${URL_BASE}/poster/poster.html"`);
  });

  it('leaves links alone in self-contained documents (no urlBase)', () => {
    const { srcdoc } = renderSandboxedBundle({
      indexHtml: '<html><body><a href="other.html">Other</a></body></html>',
      urlBase: '',
      origin: ORIGIN,
      visibility: 'private',
      assetMode: 'inline',
    });
    expect(srcdoc).toContain('href="other.html"');
  });

  it('strips frames, <base>, meta refresh and non-blessed scripts from a secondary page only', () => {
    const risky = `<html><head><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example">
<script src="https://evil.example/x.js"></script><script src="/static/lib/chart.js@4.x.js"></script></head>
<body><iframe src="/login"></iframe><object data="x"></object><script>var ok = 1;</script></body></html>`;
    const secondary = renderSandboxedBundle({
      indexHtml: risky,
      urlBase: URL_BASE,
      origin: ORIGIN,
      visibility: 'public',
      pagePath: 'guide/intro.html',
    }).srcdoc;
    expect(secondary).not.toContain('evil.example');
    expect(secondary).not.toContain('<iframe');
    expect(secondary).not.toContain('<object');
    expect(secondary).toContain(`src="${ORIGIN}/static/lib/chart.js@4.x.js"`);
    expect(secondary).toContain('var ok = 1;');
    expect(secondary.match(/<base/g) ?? []).toHaveLength(1);

    // The index went through publish-time validation instead; it is not rewritten here.
    const index = renderSandboxedBundle({
      indexHtml: '<html><body><object data="x"></object></body></html>',
      urlBase: URL_BASE,
      origin: ORIGIN,
      visibility: 'public',
    }).srcdoc;
    expect(index).toContain('<object');
  });

  it('configures bundle-link routing only when asked to', () => {
    const routed = renderSandboxedBundle({
      indexHtml: '<html><body></body></html>',
      urlBase: URL_BASE,
      origin: ORIGIN,
      visibility: 'public',
      pagePaths: [URL_BASE],
      routeBundleLinks: true,
    }).srcdoc;
    expect(routed).toContain(`"bases":["${URL_BASE}"]`);

    const isolated = renderSandboxedBundle({
      indexHtml: '<html><body></body></html>',
      urlBase: URL_BASE,
      origin: ORIGIN,
      visibility: 'public',
      pagePaths: [URL_BASE],
    }).srcdoc;
    expect(isolated).toContain('"bases":[]');
  });
});

describe('renderSandboxedBundle - signed media in gated renders', () => {
  it('points media refs at signed URLs instead of inlining or dropping them', () => {
    const signed = 'https://bundles.s3.example/user/s/clip.mp4?X-Amz-Signature=sig';
    const { srcdoc, droppedAssets } = renderSandboxedBundle({
      indexHtml:
        '<html><body><video src="../media/clip.mp4" poster="../media/still.jpg"></video>' +
        '<video><source src="../media/clip.mp4" type="video/mp4"></video></body></html>',
      urlBase: URL_BASE,
      origin: ORIGIN,
      visibility: 'private',
      pagePath: 'pages/player.html',
      assets: new Map([['media/still.jpg', asset('JPEG', 'image/jpeg')]]),
      signedAssets: new Map([['media/clip.mp4', signed]]),
    });
    expect(droppedAssets).toHaveLength(0);
    expect(srcdoc.split(`src="${signed}"`)).toHaveLength(3);
    expect(srcdoc).toContain(`poster="data:image/jpeg;base64,${Buffer.from('JPEG').toString('base64')}"`);
  });
});

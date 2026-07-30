import { describe, it, expect } from 'vitest';
import { renderSandboxedBundle, type SandboxAsset } from './renderSandboxedBundle';

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
});

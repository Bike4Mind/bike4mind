import { describe, it, expect } from 'vitest';
import {
  sanitizeRenderedHtml,
  resolveDocOrigin,
  buildBundleScriptSrc,
  isAppWrapperHost,
  isUsercontentHost,
  usercontentHostFor,
} from './viewerSecurity';
import { BLESSED_SCRIPT_PATHS, PUBLISH_HOST } from './validateBundle';

describe('sanitizeRenderedHtml', () => {
  it('strips executable / navigation-hijacking elements', () => {
    const out = sanitizeRenderedHtml(
      `<p>ok</p>` +
        `<script>alert(1)</script>` +
        `<iframe src="https://evil.test"></iframe>` +
        `<object data="x"></object>` +
        `<embed src="x">` +
        `<base href="https://evil.test/">` +
        `<meta http-equiv="refresh" content="0;url=https://evil.test">` +
        `<link rel="stylesheet" href="https://evil.test/x.css">` +
        `<form action="https://evil.test"></form>` +
        `<style>body{display:none}</style>`
    );
    expect(out).toContain('<p>ok</p>');
    for (const tag of ['<script', '<iframe', '<object', '<embed', '<base', '<meta', '<link', '<form', '<style']) {
      expect(out).not.toContain(tag);
    }
  });

  it('removes event-handler attributes but keeps the element', () => {
    const out = sanitizeRenderedHtml(`<a href="https://ok.test" onclick="steal()">x</a>`);
    expect(out).not.toContain('onclick');
    expect(out).toContain('href="https://ok.test"');
    expect(out).toContain('>x</a>');
    // the name.startsWith('on') branch is element-agnostic - pin it on other element types
    // (<img onerror>, <svg onload>) so it isn't read as anchor-only.
    const img = sanitizeRenderedHtml(`<img src="https://ok.test/x.png" onerror="steal()">`);
    expect(img).not.toContain('onerror');
    expect(img).toContain('src="https://ok.test/x.png"');
    const svg = sanitizeRenderedHtml(`<svg onload="steal()">x</svg>`);
    expect(svg).not.toContain('onload');
    expect(svg).toContain('<svg');
  });

  it('strips javascript:/vbscript:/data: from navigational attributes', () => {
    expect(sanitizeRenderedHtml(`<a href="javascript:alert(1)">x</a>`)).not.toContain('javascript:');
    expect(sanitizeRenderedHtml(`<a href="vbscript:msgbox(1)">x</a>`)).not.toContain('vbscript:');
    // data:text/html link is a navigation/XSS vector - stripped from href.
    expect(sanitizeRenderedHtml(`<a href="data:text/html,<script>">x</a>`)).not.toContain('href="data:');
    // matching is case-insensitive and tolerant of leading whitespace.
    expect(sanitizeRenderedHtml(`<a href="  JaVaScRiPt:alert(1)">x</a>`)).not.toContain('JaVaScRiPt:');
  });

  it('applies the navigational-attr policy to xlink:href, action and formaction too', () => {
    // xlink:href on inline SVG anchors is a real navigation vector.
    expect(sanitizeRenderedHtml(`<svg><a xlink:href="javascript:alert(1)">x</a></svg>`)).not.toContain('javascript:');
    expect(sanitizeRenderedHtml(`<svg><a xlink:href="data:text/html,x">y</a></svg>`)).not.toContain(
      'xlink:href="data:'
    );
    // form is stripped wholesale, but the action/formaction policy must still hold on any
    // element that carries them (e.g. a button outside a form).
    expect(sanitizeRenderedHtml(`<button formaction="javascript:alert(1)">go</button>`)).not.toContain('javascript:');
    expect(sanitizeRenderedHtml(`<button formaction="data:text/html,x">go</button>`)).not.toContain(
      'formaction="data:'
    );
  });

  it('keeps data: on src so inline data-URI images still render', () => {
    const dataImg = 'data:image/png;base64,iVBORw0KGgo=';
    const out = sanitizeRenderedHtml(`<img src="${dataImg}">`);
    expect(out).toContain(`src="${dataImg}"`);
  });

  it('strips javascript:/vbscript: from src but leaves http(s) src intact', () => {
    expect(sanitizeRenderedHtml(`<img src="javascript:alert(1)">`)).not.toContain('javascript:');
    expect(sanitizeRenderedHtml(`<img src="vbscript:msgbox(1)">`)).not.toContain('vbscript:');
    expect(sanitizeRenderedHtml(`<img src="https://ok.test/a.png">`)).toContain('src="https://ok.test/a.png"');
  });

  it('leaves benign rendered markdown intact (heading, link, code block, http(s) image)', () => {
    // guards the inverse failure mode: a future over-aggressive strip must not eat legitimate content.
    const out = sanitizeRenderedHtml(
      `<h1>Title</h1>` +
        `<p>intro <a href="https://ok.test">link</a></p>` +
        `<pre><code>const x = 1;</code></pre>` +
        `<p><img src="https://ok.test/x.png" alt="diagram"></p>`
    );
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('href="https://ok.test"');
    expect(out).toContain('<pre><code>');
    expect(out).toContain('const x = 1;');
    expect(out).toContain('src="https://ok.test/x.png"');
  });
});

describe('resolveDocOrigin (untrusted Host / X-Forwarded-Proto)', () => {
  it('honors a well-formed host and defaults to https', () => {
    expect(resolveDocOrigin('app.pr123.preview.bike4mind.com')).toBe('https://app.pr123.preview.bike4mind.com');
  });

  it('preserves an explicit port', () => {
    expect(resolveDocOrigin('app.bike4mind.com:8443')).toBe('https://app.bike4mind.com:8443');
  });

  it('uses http for localhost / loopback hosts', () => {
    expect(resolveDocOrigin('localhost:3000')).toBe('http://localhost:3000');
    expect(resolveDocOrigin('127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });

  it('falls back to PUBLISH_HOST when the host header is malformed (CSP injection guard)', () => {
    // a crafted Host trying to inject a directive must not survive into the origin.
    expect(resolveDocOrigin('evil.test/ ; script-src *')).toBe(`https://${PUBLISH_HOST}`);
    expect(resolveDocOrigin('has space.test')).toBe(`https://${PUBLISH_HOST}`);
    expect(resolveDocOrigin(undefined)).toBe(`https://${PUBLISH_HOST}`);
  });

  it('falls back to PUBLISH_HOST for a well-formed but non-allowlisted host', () => {
    // format-valid but not a bike4mind/localhost host - must not reach the CSP.
    expect(resolveDocOrigin('attacker.com')).toBe(`https://${PUBLISH_HOST}`);
    // suffix attack: `.bike4mind.com` requires the leading dot.
    expect(resolveDocOrigin('evilbike4mind.com')).toBe(`https://${PUBLISH_HOST}`);
    // allowlisted hosts are preserved.
    expect(resolveDocOrigin('app.staging.bike4mind.com')).toBe('https://app.staging.bike4mind.com');
  });

  it('respects a valid X-Forwarded-Proto and ignores an invalid one', () => {
    expect(resolveDocOrigin('app.bike4mind.com', 'http')).toBe('http://app.bike4mind.com');
    expect(resolveDocOrigin('app.bike4mind.com', 'https')).toBe('https://app.bike4mind.com');
    // takes the first value from a comma list and trims it
    expect(resolveDocOrigin('app.bike4mind.com', 'http, https')).toBe('http://app.bike4mind.com');
    // array header (Node can surface duplicates as an array)
    expect(resolveDocOrigin('app.bike4mind.com', ['https', 'http'])).toBe('https://app.bike4mind.com');
    // garbage proto -> fall through to host-based default (https for non-loopback)
    expect(resolveDocOrigin('app.bike4mind.com', 'gopher')).toBe('https://app.bike4mind.com');
  });
});

describe('buildBundleScriptSrc', () => {
  it('emits the blessed libs at both the document origin and the canonical app host', () => {
    const src = buildBundleScriptSrc(PUBLISH_HOST, 'https');
    for (const p of BLESSED_SCRIPT_PATHS) {
      expect(src).toContain(`https://${PUBLISH_HOST}${p}`);
    }
  });

  it('includes the document-origin form for preview hosts (same-origin libs)', () => {
    const src = buildBundleScriptSrc('app.pr5.preview.bike4mind.com', 'https');
    const p = BLESSED_SCRIPT_PATHS[0];
    expect(src).toContain(`https://app.pr5.preview.bike4mind.com${p}`);
    expect(src).toContain(`https://${PUBLISH_HOST}${p}`);
  });

  it('deduplicates when the document origin equals the canonical app host', () => {
    const src = buildBundleScriptSrc(PUBLISH_HOST, 'https');
    const tokens = src.split(' ');
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens).toHaveLength(BLESSED_SCRIPT_PATHS.length);
  });

  it('never contains a CSP-directive separator even with a hostile host header', () => {
    const src = buildBundleScriptSrc('evil.test/ ; script-src *', 'https');
    expect(src).not.toContain(';');
    expect(src).not.toContain('*');
    // hostile host was discarded -> only the canonical app host remains
    expect(src).toContain(`https://${PUBLISH_HOST}${BLESSED_SCRIPT_PATHS[0]}`);
  });
});

describe('isAppWrapperHost / isUsercontentHost — host classification', () => {
  // SERVER_DOMAIN=bike4mind.com in vitest.setup -> PUBLISH_HOST=app.bike4mind.com,
  // usercontent suffix=.usercontent.app.bike4mind.com (nested under the app host).
  const usercontentHost = usercontentHostFor('pub1'); // pub1.usercontent.app.bike4mind.com

  it('treats the canonical app host as a wrapper host (port-tolerant)', () => {
    expect(isAppWrapperHost('app.bike4mind.com')).toBe(true);
    expect(isAppWrapperHost('app.bike4mind.com:443')).toBe(true);
    expect(isAppWrapperHost(['app.bike4mind.com'])).toBe(true);
  });

  it('does NOT treat a usercontent (bundle) host as a wrapper host', () => {
    // Regression guard: usercontent is nested under `.app.<domain>`, so a naive
    // `endsWith('.app.<domain>')` check would wrongly classify it as a trusted wrapper.
    expect(isUsercontentHost(usercontentHost)).toBe(true);
    expect(isAppWrapperHost(usercontentHost)).toBe(false);
    expect(isAppWrapperHost('pub1.usercontent.app.bike4mind.com:443')).toBe(false);
  });

  it('rejects unrelated and apex-sibling hosts', () => {
    expect(isAppWrapperHost('evil.bike4mind.com')).toBe(false);
    expect(isAppWrapperHost('bike4mind.com')).toBe(false);
    expect(isAppWrapperHost(undefined)).toBe(false);
  });
});

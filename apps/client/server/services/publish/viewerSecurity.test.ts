import { describe, it, expect, vi, afterEach } from 'vitest';
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

describe('self-host CSP (B4M_SELF_HOST=true, SERVER_DOMAIN unset -> PUBLISH_HOST empty)', () => {
  const P0 = BLESSED_SCRIPT_PATHS[0];

  // PUBLISH_HOST is resolved at module-load from SERVER_DOMAIN, so re-import the
  // modules with the self-host env stubbed to exercise the empty-PUBLISH_HOST path.
  async function loadSelfHost() {
    vi.stubEnv('SERVER_DOMAIN', '');
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.resetModules();
    return import('./viewerSecurity');
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('emits no scheme-only https:/// token when PUBLISH_HOST is unset', async () => {
    const { buildBundleScriptSrc } = await loadSelfHost();
    const src = buildBundleScriptSrc('localhost:3000');
    expect(src).not.toContain('https:///');
    expect(src).not.toContain('https://'); // localhost self-host resolves to http
    expect(src).toContain(`http://localhost:3000${P0}`);
  });

  it('serves blessed libs same-origin over http for a localhost self-host viewer', async () => {
    const { buildBundleScriptSrc } = await loadSelfHost();
    const src = buildBundleScriptSrc('localhost:3000');
    for (const p of BLESSED_SCRIPT_PATHS) {
      expect(src).toContain(`http://localhost:3000${p}`);
    }
  });

  it('trusts a LAN/tailnet Host and resolves it over http', async () => {
    const { buildBundleScriptSrc, resolveDocOrigin } = await loadSelfHost();
    expect(resolveDocOrigin('host.lan:3000')).toBe('http://host.lan:3000');
    expect(buildBundleScriptSrc('host.lan:3000')).toContain(`http://host.lan:3000${P0}`);
  });

  it('upgrades the scheme to https when a TLS reverse proxy sets X-Forwarded-Proto', async () => {
    const { buildBundleScriptSrc, resolveDocOrigin } = await loadSelfHost();
    expect(resolveDocOrigin('artifacts.example.internal', 'https')).toBe('https://artifacts.example.internal');
    expect(buildBundleScriptSrc('artifacts.example.internal', 'https')).toContain(
      `https://artifacts.example.internal${P0}`
    );
  });

  it('never lets a hostile Host inject a CSP directive even in self-host', async () => {
    const { buildBundleScriptSrc } = await loadSelfHost();
    const src = buildBundleScriptSrc('evil.test/ ; script-src *');
    expect(src).not.toContain(';');
    expect(src).not.toContain('*');
  });

  it('falls back to a safe localhost origin (never a bare scheme) for a malformed Host', async () => {
    const { buildBundleScriptSrc, resolveDocOrigin } = await loadSelfHost();
    // A malformed-but-non-injecting Host fails the format gate; with PUBLISH_HOST
    // unset the fallback must be `localhost`, never '' (which would yield http:///).
    expect(resolveDocOrigin('has space.test')).toBe('http://localhost');
    const src = buildBundleScriptSrc('has space.test');
    expect(src).not.toContain('http:///');
    expect(src).not.toContain('https:///');
    expect(src).toContain(`http://localhost${P0}`);
  });
});

describe('buildBundleScriptSrc hosted regression (byte-identical, B4M_SELF_HOST unset)', () => {
  it('produces the exact deduped doc-origin + app-host token string', () => {
    // Hardcoded expected (NOT re-derived with the implementation's own Set/join),
    // so an identical bug on both sides can't pass. Regenerate this literal if
    // BLESSED_SCRIPT_PATHS or PUBLISH_HOST (SERVER_DOMAIN=bike4mind.com in setup) changes.
    const expected =
      'https://app.pr5.preview.bike4mind.com/static/lib/chart.js@4.x.js https://app.pr5.preview.bike4mind.com/static/b4m-client.js@1.x.js https://app.pr5.preview.bike4mind.com/static/lib/react@18.x.js https://app.pr5.preview.bike4mind.com/static/lib/react-dom@18.x.js https://app.pr5.preview.bike4mind.com/static/lib/prop-types@15.x.js https://app.pr5.preview.bike4mind.com/static/lib/recharts@2.x.js https://app.pr5.preview.bike4mind.com/static/lib/lucide@1.x.js https://app.pr5.preview.bike4mind.com/static/lib/d3@7.x.js https://app.pr5.preview.bike4mind.com/static/lib/lodash@4.x.js https://app.pr5.preview.bike4mind.com/static/lib/mathjs@11.x.js https://app.pr5.preview.bike4mind.com/static/lib/papaparse@5.x.js https://app.pr5.preview.bike4mind.com/static/lib/xlsx@0.18.x.js https://app.bike4mind.com/static/lib/chart.js@4.x.js https://app.bike4mind.com/static/b4m-client.js@1.x.js https://app.bike4mind.com/static/lib/react@18.x.js https://app.bike4mind.com/static/lib/react-dom@18.x.js https://app.bike4mind.com/static/lib/prop-types@15.x.js https://app.bike4mind.com/static/lib/recharts@2.x.js https://app.bike4mind.com/static/lib/lucide@1.x.js https://app.bike4mind.com/static/lib/d3@7.x.js https://app.bike4mind.com/static/lib/lodash@4.x.js https://app.bike4mind.com/static/lib/mathjs@11.x.js https://app.bike4mind.com/static/lib/papaparse@5.x.js https://app.bike4mind.com/static/lib/xlsx@0.18.x.js';
    expect(buildBundleScriptSrc('app.pr5.preview.bike4mind.com', 'https')).toBe(expected);
  });
});

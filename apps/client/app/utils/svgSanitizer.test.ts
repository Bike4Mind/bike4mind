import { describe, it, expect } from 'vitest';
import {
  cssHasCrossOriginReference,
  cssHasRemoteReference,
  isCrossOriginUrl,
  sanitizeArtifactSvg,
  toSvgImageSource,
} from './svgSanitizer';

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`;

describe('sanitizeArtifactSvg', () => {
  // SMIL animation elements can rewrite an <a href> to javascript: at runtime.
  it('strips SMIL animation elements', () => {
    const clean = sanitizeArtifactSvg(
      svg(
        '<a><animate attributeName="href" to="javascript:alert(1)" /><set attributeName="href" to="javascript:alert(1)" /><text>x</text></a>'
      )
    );
    expect(clean).not.toContain('<animate');
    expect(clean).not.toContain('<set');
    expect(clean).not.toContain('javascript:');
  });

  it('keeps switch, foreignObject and metadata but still removes scripts inside them', () => {
    const clean = sanitizeArtifactSvg(
      svg(
        '<metadata>info</metadata><switch><foreignObject width="10" height="10"><div>hi<script>alert(1)</script></div></foreignObject><text>fallback</text></switch>'
      )
    );
    expect(clean).toContain('<switch');
    expect(clean).toContain('<foreignObject');
    expect(clean).toContain('<metadata');
    expect(clean).not.toContain('<script');
  });

  it('keeps ordinary shapes, gradients and in-document references', () => {
    const clean = sanitizeArtifactSvg(
      svg(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="red" /></linearGradient><circle id="c" r="1" /></defs>' +
          '<rect width="10" height="10" fill="url(#g)" /><use href="#c" />'
      )
    );
    expect(clean).toContain('<rect');
    expect(clean).toContain('fill="url(#g)"');
    expect(clean).toContain('href="#c"');
  });

  it('strips event-handler attributes', () => {
    expect(sanitizeArtifactSvg(svg('<rect onload="steal()" />'))).not.toContain('onload');
  });

  it('removes remote image and use targets but keeps inline data images', () => {
    const clean = sanitizeArtifactSvg(
      svg(
        '<image href="https://example.com/a.png" /><image xlink:href="//example.com/b.png" />' +
          '<use href="https://example.com/s.svg#x" /><image href="data:image/png;base64,AAAA" />'
      )
    );
    expect(clean).not.toContain('example.com');
    expect(clean).toContain('data:image/png;base64,AAAA');
  });

  it('removes style blocks and attributes that load external resources', () => {
    const clean = sanitizeArtifactSvg(
      svg(
        '<style>@import url(https://example.com/a.css);</style>' +
          '<rect style="fill: u\\72l(https://example.com/f)" />' +
          '<rect filter="url(https://example.com/f.svg#x)" />'
      )
    );
    expect(clean).not.toContain('example.com');
    expect(clean).not.toContain('@import');
  });

  it('drops only the remote parts of a style block', () => {
    const clean = sanitizeArtifactSvg(
      svg(
        '<style>@import url("https://fonts.googleapis.com/css2?family=Inter&display=swap");' +
          '.a{fill:red}.b{background:url(https://example.com/x.png);stroke:blue}.c{fill:url(#g)}</style><rect class="a" />'
      )
    );
    expect(clean).not.toContain('googleapis');
    expect(clean).not.toContain('example.com');
    expect(clean).toContain('.a{fill:red}');
    expect(clean).toContain('stroke:blue');
    expect(clean).toContain('.c{fill:url(#g)}');
  });

  it('removes a style block whose remote reference is escaped past the rewrite', () => {
    const clean = sanitizeArtifactSvg(
      svg('<style>.a{fill:red}@\\69mport "https://example.com/a.css";</style><rect />')
    );
    expect(clean).not.toContain('example.com');
    expect(clean).not.toContain('fill:red');
  });

  it('keeps self-contained style blocks', () => {
    expect(sanitizeArtifactSvg(svg('<style>.a { fill: red; }</style><rect class="a" />'))).toContain('fill: red');
  });

  it('returns an empty string when no svg survives', () => {
    expect(sanitizeArtifactSvg('<script>alert(1)</script>')).toBe('');
  });
});

describe('toSvgImageSource', () => {
  it('produces a data: URL of a namespaced svg document', () => {
    const source = toSvgImageSource('<svg viewBox="0 0 10 10"><circle r="4" /></svg>');
    expect(source?.src.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeURIComponent(source!.src)).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(source?.hasIntrinsicWidth).toBe(false);
  });

  it('reports an absolute root width', () => {
    expect(toSvgImageSource('<svg width="120" height="40"><rect /></svg>')?.hasIntrinsicWidth).toBe(true);
  });

  it('returns null for content with no svg', () => {
    expect(toSvgImageSource('hello')).toBeNull();
  });
});

describe('cssHasRemoteReference', () => {
  it.each([
    'url(https://example.com/a)',
    "url('//example.com/a')",
    '@import "a.css"',
    'image-set("https://example.com/a.png" 1x)',
    '\\75 rl(https://example.com/a)',
  ])('flags %s', css => {
    expect(cssHasRemoteReference(css)).toBe(true);
  });

  it.each(['url(#marker)', "url('data:image/png;base64,AA')", 'fill: red', 'Load the src (main) file', 'getUrl()'])(
    'allows %s',
    css => {
      expect(cssHasRemoteReference(css)).toBe(false);
    }
  );
});

describe('cssHasCrossOriginReference', () => {
  it.each([
    'fill:url(https://example.com/x)',
    'url(//example.com/x)',
    'url("ht\\\ntps://example.com")',
    'url(\\\\\\\\example.com/x)',
    'url(\\/\\/example.com/x)',
  ])('flags %s', css => {
    expect(cssHasCrossOriginReference(css)).toBe(true);
  });

  it.each(['A->>B: getUrl()', 'n["new URL(path)"]', 'toDataUrl(canvas)', 'url(#marker)', '@import "a.css"'])(
    'allows %s',
    css => {
      expect(cssHasCrossOriginReference(css)).toBe(false);
    }
  );
});

describe('isCrossOriginUrl', () => {
  it.each([
    'https://example.com',
    '//example.com',
    '\\\\example.com',
    'ht\ttps://example.com',
    ' "HTTP://example.com"',
  ])('flags %s', url => {
    expect(isCrossOriginUrl(url)).toBe(true);
  });

  it.each(['#a', 'data:image/png;base64,AA', 'path/to.png', '/static/a.png'])('allows %s', url => {
    expect(isCrossOriginUrl(url)).toBe(false);
  });
});

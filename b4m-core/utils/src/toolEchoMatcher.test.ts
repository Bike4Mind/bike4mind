import { describe, it, expect } from 'vitest';
import { createToolEchoMatcher, normalizeForToolEcho, MIN_TOOL_ECHO_LENGTH } from './toolEchoMatcher';

const DOC =
  '<!DOCTYPE html>\n<html>\n  <head><title>Fetched &amp; Quoted</title></head>\n  <body><p class="x">Hello from the fetched page, quoted back verbatim.</p></body>\n</html>';

describe('normalizeForToolEcho', () => {
  it('removes markdown escapes, decodes entities, collapses whitespace', () => {
    expect(normalizeForToolEcho('  a\\*b\\_c &lt;p&gt; &quot;q&quot; &#39;s&#39;&nbsp;x\n\n\ty  ')).toBe(
      'a*b_c <p> "q" \'s\' x y'
    );
  });

  it('decodes each entity once', () => {
    expect(normalizeForToolEcho('&amp;lt;')).toBe('&lt;');
  });
});

describe('createToolEchoMatcher', () => {
  it('never matches with no sources or only empty ones', () => {
    expect(createToolEchoMatcher([])(DOC)).toBe(false);
    expect(createToolEchoMatcher([{ text: '', truncated: false }])(DOC)).toBe(false);
  });

  it('matches a verbatim quote and a substring of the source', () => {
    const isEcho = createToolEchoMatcher([{ text: `Page content:\n${DOC}\nEnd.`, truncated: false }]);
    expect(isEcho(DOC)).toBe(true);
    expect(isEcho(DOC.slice(0, 80))).toBe(true);
  });

  it('does not match authored content that differs from the source', () => {
    const isEcho = createToolEchoMatcher([{ text: DOC, truncated: false }]);
    expect(isEcho(DOC.replace('Hello', 'Goodbye'))).toBe(false);
  });

  it('applies the minimum length to the normalized body', () => {
    const source = 'x'.repeat(200);
    const isEcho = createToolEchoMatcher([{ text: source, truncated: false }]);
    expect(isEcho('')).toBe(false);
    expect(isEcho('x'.repeat(MIN_TOOL_ECHO_LENGTH - 1))).toBe(false);
    expect(isEcho('x'.repeat(MIN_TOOL_ECHO_LENGTH))).toBe(true);
    expect(isEcho(`   ${'x'.repeat(MIN_TOOL_ECHO_LENGTH - 1)}   `)).toBe(false);
  });

  it('matches an echo that differs only in whitespace, markdown escapes or entities', () => {
    const isEcho = createToolEchoMatcher([{ text: DOC, truncated: false }]);
    expect(isEcho(DOC.replace(/\n\s*/g, ' '))).toBe(true);
    expect(isEcho(DOC.replace('&amp;', '&'))).toBe(true);
    expect(isEcho(DOC.replace('<p class="x">', '<p class=&quot;x&quot;>'))).toBe(true);
    expect(isEcho(DOC.replace('<!DOCTYPE', '<\\!DOCTYPE'))).toBe(true);
  });

  it('matches HTML carried as an escaped string inside a JSON tool result', () => {
    const isEcho = createToolEchoMatcher([{ text: JSON.stringify({ result: { html: DOC } }), truncated: false }]);
    expect(isEcho(DOC)).toBe(true);
  });

  it('ignores JSON string leaves past the depth cap', () => {
    const deep = { a: { b: { c: { d: { e: DOC } } } } };
    expect(createToolEchoMatcher([{ text: JSON.stringify(deep), truncated: false }])(DOC)).toBe(false);
  });

  describe('truncated sources', () => {
    const long = `<!DOCTYPE html><html><body>${Array.from({ length: 120 }, (_, i) => `<p>row ${i}</p>`).join('')}</body></html>`;
    const cut = long.slice(0, 1400);

    it('matches a body that continues past the truncation point', () => {
      expect(createToolEchoMatcher([{ text: cut, truncated: true }])(long)).toBe(true);
    });

    it('does not extend past the cut for a source that is not truncated', () => {
      expect(createToolEchoMatcher([{ text: cut, truncated: false }])(long)).toBe(false);
    });

    it('needs a substantial overlap before the cut', () => {
      const short = long.slice(0, 600);
      expect(createToolEchoMatcher([{ text: short, truncated: true }])(long)).toBe(false);
    });

    it('does not match a body that diverges before the cut', () => {
      const diverged = long.replace('<p>row 30</p>', '<p>authored</p>');
      expect(createToolEchoMatcher([{ text: cut, truncated: true }])(diverged)).toBe(false);
    });
  });
});

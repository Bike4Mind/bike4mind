import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { describe, expect, it } from 'vitest';
import { fastRenderer, highlightElement, type HighlightRenderer } from './highlightElements';
import { SYNTAX_THEMES } from './syntaxTheme';

const libraryRenderer: HighlightRenderer = ({ rows, stylesheet, useInlineStyles }) =>
  rows.map((row, index) => createElement({ node: row, stylesheet, useInlineStyles, key: `code-segment-${index}` }));

const SAMPLES: [string, string][] = [
  ['tsx', 'export const App = () => <div className="x">{`${a}`}</div>; // done'],
  ['python', 'def f(x: int) -> str:\n    """doc"""\n    return f"{x!r}"'],
  ['css', '.a > .b:hover { color: rgb(0 0 0 / 50%); }'],
  ['bash', 'for f in *.ts; do echo "$f" | grep -v test; done'],
];

function markup(language: string, code: string, mode: 'light' | 'dark', renderer: HighlightRenderer, inline = true) {
  return renderToStaticMarkup(
    <SyntaxHighlighter
      language={language}
      style={SYNTAX_THEMES[mode]}
      PreTag="div"
      renderer={renderer}
      wrapLines={false}
      useInlineStyles={inline}
    >
      {code}
    </SyntaxHighlighter>
  );
}

/** A drop-in has to be exactly that: the same tokens, classes and colours as the library's own. */
describe('highlightElement', () => {
  for (const [language, code] of SAMPLES) {
    for (const mode of ['light', 'dark'] as const) {
      it(`draws ${language} in ${mode} exactly as the library does`, () => {
        expect(markup(language, code, mode, fastRenderer)).toBe(markup(language, code, mode, libraryRenderer));
      });
    }
  }

  it('matches without inline styles too', () => {
    const [language, code] = SAMPLES[0];
    expect(markup(language, code, 'light', fastRenderer, false)).toBe(
      markup(language, code, 'light', libraryRenderer, false)
    );
  });

  it('returns text nodes as their text', () => {
    expect(highlightElement({ type: 'text', value: 'plain' }, SYNTAX_THEMES.light, true, 'k')).toBe('plain');
  });
});

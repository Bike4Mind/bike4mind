import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatDiff, ChatDiffLine } from '@shared/chat';
import { DiffView } from './DiffView';
import { diffLanguage } from './diffLanguage';
import { createElement, Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { fastRenderer, highlightElement, type HighlightRenderer } from './markdown/highlightElements';
import { SYNTAX_THEMES } from './markdown/syntaxTheme';

/**
 * Rendered to a string, like ReplyMarkdown's tests and for the same reason: this package's
 * vitest runs on `node`, and the questions worth asking here - is every line still present, is
 * it still on the right side, did the highlighter swallow one - are answerable from the markup.
 * It also means the assertions run through the real Prism pipeline rather than a stand-in.
 */
const render = (diff: ChatDiff) => renderToStaticMarkup(<DiffView diff={diff} />);

/**
 * The rendered text with the markup taken out.
 *
 * Needed because highlighting is the point: a highlighted line is a dozen `span`s, so a source
 * line never appears in the markup as one run of characters. The emotion `style` blocks go too
 * - they are full of CSS that would otherwise match anything looked for here.
 */
function text(diff: ChatDiff): string {
  return render(diff)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, '');
}

function diffOf(lines: ChatDiffLine[], overrides: Partial<ChatDiff> = {}): ChatDiff {
  return {
    path: '/repo/src/ChatService.ts',
    operation: 'edit',
    added: lines.filter(line => line.kind === 'add').length,
    removed: lines.filter(line => line.kind === 'remove').length,
    lines,
    ...overrides,
  };
}

describe('DiffView', () => {
  it('keeps every line, on the side it belongs to', () => {
    const diff = diffOf([
      { kind: 'context', text: 'const before = 1;', oldLine: 1, newLine: 1 },
      { kind: 'remove', text: 'const gone = 2;', oldLine: 2 },
      { kind: 'add', text: 'const added = 3;', newLine: 2 },
    ]);

    expect(text(diff)).toContain('const before = 1;');
    expect(text(diff)).toContain('const gone = 2;');
    expect(text(diff)).toContain('const added = 3;');

    const html = render(diff);
    expect(html.match(/data-kind="add"/g)).toHaveLength(1);
    expect(html.match(/data-kind="remove"/g)).toHaveLength(1);
    expect(html.match(/data-kind="context"/g)).toHaveLength(1);
  });

  it('colours the source rather than tinting it all one colour', () => {
    const html = render(diffOf([{ kind: 'add', text: 'const answer = 42;', newLine: 1 }]));

    // Prism's own token spans. Their presence is the whole claim: the line went through the
    // tokenizer rather than being printed as one undifferentiated run of text.
    expect((html.match(/class="token"/g) ?? []).length).toBeGreaterThan(1);
  });

  // A gap contributes a blank line to what the tokenizer is given, so that every row after it
  // still lines up with the diff line it came from.
  it('keeps the rows aligned across a gap', () => {
    const rendered = text(
      diffOf([
        { kind: 'remove', text: 'const first = 1;', oldLine: 1 },
        { kind: 'gap', text: '40 unchanged lines' },
        { kind: 'add', text: 'const last = 2;', newLine: 42 },
      ])
    );

    expect(rendered).toContain('40 unchanged lines');
    expect(rendered.indexOf('const first = 1;')).toBeLessThan(rendered.indexOf('40 unchanged lines'));
    expect(rendered.indexOf('40 unchanged lines')).toBeLessThan(rendered.indexOf('const last = 2;'));
  });

  it('renders an empty change without falling over', () => {
    expect(() => render(diffOf([], { added: 0, removed: 0 }))).not.toThrow();
  });

  it('says so when the change was too large to show exactly', () => {
    expect(text(diffOf([{ kind: 'add', text: 'x', newLine: 1 }], { truncated: true }))).toContain(
      'Too large to show line by line'
    );
  });
});

describe('diffLanguage', () => {
  it('reads the language off the extension', () => {
    expect(diffLanguage('/repo/src/ChatService.ts')).toBe('typescript');
    expect(diffLanguage('/repo/src/App.tsx')).toBe('tsx');
    expect(diffLanguage('/repo/deploy.sh')).toBe('bash');
  });

  it('knows the files whose whole name is the type', () => {
    expect(diffLanguage('/repo/Dockerfile')).toBe('docker');
  });

  it('leaves anything it does not recognise alone', () => {
    expect(diffLanguage('/repo/LICENSE')).toBe('text');
    expect(diffLanguage('/repo/notes.wat')).toBe('text');
    expect(diffLanguage('/repo/.gitignore')).toBe('text');
  });
});

describe('diffLanguage', () => {
  it('reads known file names and extensions', () => {
    expect(diffLanguage('src/Dockerfile')).toBe('docker');
    expect(diffLanguage('a/b.ts')).toBe('typescript');
  });

  it('treats a name or extension that is an Object member as unrecognised', () => {
    expect(diffLanguage('constructor')).toBe('text');
    expect(diffLanguage('src/a.constructor')).toBe('text');
    expect(diffLanguage('src/a.__proto__')).toBe('text');
  });
});

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

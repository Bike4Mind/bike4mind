import type { CSSProperties } from 'react';

/**
 * Prism themes for chat-reply code blocks, derived from the Observatory
 * palette in `observatory.css` so a fenced block sits in the same room as the
 * prose around it instead of importing a second design language.
 *
 * Three rules carry the whole thing:
 *   - comments recede to tertiary ink, because a comment is apparatus;
 *   - strings and numbers are the only warm notes, so literal data is the one
 *     thing that reads as content rather than as structure;
 *   - keywords sit a step off the accent, near enough to belong to it and far
 *     enough that an actual link or action still wins the eye.
 *
 * Shape matches react-syntax-highlighter's other Prism styles: a flat map of
 * selector to inline-style object, passed as the `style` prop. The Prism
 * plugin selectors oneDark also ships (rainbow-braces, previewers, diff and
 * line-number chrome) are omitted - none of those plugins are loaded here.
 */
export type PrismStyle = Record<string, CSSProperties>;

interface Palette {
  bg: string;
  fg: string;
  ink: string;
  ink3: string;
  keyword: string;
  string: string;
  number: string;
  danger: string;
  ok: string;
  selection: string;
}

const DARK: Palette = {
  bg: '#0C1218',
  fg: '#A6B5C1',
  ink: '#E8EDF2',
  ink3: '#6C7D8B',
  keyword: '#8FC1F0',
  string: '#D9A45E',
  number: '#E8A33D',
  danger: '#E5555A',
  ok: '#43D08C',
  selection: 'rgba(90, 170, 234, 0.18)',
};

const LIGHT: Palette = {
  bg: '#EDF2F6',
  fg: '#425663',
  ink: '#141F28',
  ink3: '#768895',
  keyword: '#2364A8',
  string: '#8A5A12',
  number: '#9A6410',
  danger: '#C41C1C',
  ok: '#167230',
  selection: 'rgba(11, 107, 203, 0.14)',
};

const FONT_STACK =
  "var(--joy-fontFamily-code, ui-monospace, 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'source-code-pro', monospace)";

/**
 * Builds the full Prism style map for one palette.
 */
const build = (p: Palette): PrismStyle => {
  const base: CSSProperties = {
    background: p.bg,
    color: p.fg,
    fontFamily: FONT_STACK,
    direction: 'ltr',
    textAlign: 'left',
    whiteSpace: 'pre',
    wordSpacing: 'normal',
    wordBreak: 'normal',
    lineHeight: '1.55',
    MozTabSize: '2',
    OTabSize: '2',
    tabSize: '2',
    WebkitHyphens: 'none',
    MozHyphens: 'none',
    msHyphens: 'none',
    hyphens: 'none',
  };

  const selection: CSSProperties = { background: p.selection, color: 'inherit', textShadow: 'none' };
  const recessive: CSSProperties = { color: p.ink3 };
  const comment: CSSProperties = { color: p.ink3, fontStyle: 'italic' };
  const literal: CSSProperties = { color: p.string };
  const numeric: CSSProperties = { color: p.number };
  const keyword: CSSProperties = { color: p.keyword };
  const structure: CSSProperties = { color: p.ink };
  const body: CSSProperties = { color: p.fg };

  return {
    'code[class*="language-"]': base,
    'pre[class*="language-"]': {
      ...base,
      padding: '1em',
      margin: '0.5em 0',
      overflow: 'auto',
      borderRadius: '8px',
      border: '1px solid rgba(128, 150, 170, 0.16)',
    },
    ':not(pre) > code[class*="language-"]': {
      background: p.bg,
      padding: '0.1em 0.3em',
      borderRadius: '0.3em',
      whiteSpace: 'normal',
    },

    'code[class*="language-"]::-moz-selection': selection,
    'code[class*="language-"] *::-moz-selection': selection,
    'pre[class*="language-"] *::-moz-selection': selection,
    'code[class*="language-"]::selection': selection,
    'code[class*="language-"] *::selection': selection,
    'pre[class*="language-"] *::selection': selection,

    comment,
    prolog: comment,
    cdata: comment,
    doctype: comment,

    punctuation: recessive,
    operator: recessive,
    entity: { ...recessive, cursor: 'help' },

    keyword,
    atrule: keyword,
    important: { ...keyword, fontWeight: 'bold' },
    selector: keyword,
    'attr-name': keyword,

    tag: structure,
    'class-name': structure,
    function: structure,
    builtin: structure,
    symbol: structure,
    namespace: { ...structure, opacity: 0.7 },

    string: literal,
    char: literal,
    regex: literal,
    url: literal,
    'attr-value': literal,
    inserted: { color: p.ok },

    number: numeric,
    boolean: numeric,
    constant: numeric,

    variable: body,
    property: body,

    deleted: { color: p.danger },

    bold: { fontWeight: 'bold' },
    italic: { fontStyle: 'italic' },
  };
};

/** Prism theme for chat-reply code blocks in dark mode. */
export const observatoryDark: PrismStyle = build(DARK);

/** Prism theme for chat-reply code blocks in light mode. */
export const observatoryLight: PrismStyle = build(LIGHT);

/** Returns the reply code-block Prism theme matching the resolved color scheme. */
export const getMarkdownSyntaxTheme = (mode: 'light' | 'dark' | undefined): PrismStyle =>
  mode === 'light' ? observatoryLight : observatoryDark;

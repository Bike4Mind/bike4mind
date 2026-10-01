import remarkGfm from 'remark-gfm';

/**
 * remark-gfm configured with single-tilde strikethrough DISABLED.
 *
 * remark-gfm's `singleTilde` option defaults to true, so a lone `~` that the LLM
 * uses as an "approximately" shorthand (e.g. `~$15M ... ~$40M`) renders the text
 * between two tildes as strikethrough. Disabling it keeps real strikethrough
 * (`~~text~~`) working while leaving single tildes as literal text.
 *
 * Use this in every renderer that displays LLM / AI-generated markdown so the
 * behavior stays consistent and the fix does not drift across surfaces.
 */
export const remarkGfmNoSingleTilde: [typeof remarkGfm, { singleTilde: false }] = [remarkGfm, { singleTilde: false }];

// Matches a single-dollar span with no nested/adjacent `$` and no newline, using pandoc's
// delimiter shape as the gate: opening `$` not followed by whitespace, closing `$` not preceded
// by whitespace and not followed by a digit. That last check is what rejects currency runs like
// "$5 to $10", "$124 and $150 per seat", and "~$15M ... ~$40M" - each has another amount right
// after the "closing" dollar. We widen pandoc's digit rule to any word char or `{` so shell
// variables ("$HOME=$PWD", "$PATH/$SUBDIR", "${A}${B}") are rejected the same way; the cost is
// that "$n$th" stays literal. Content still has to pass `looksLikeMath` below to be promoted.
const SINGLE_DOLLAR_SPAN = /(?<!\$)\$(?!\$)(?!\s)([^$\n]*[^$\n\s])(?<!\$)\$(?!\$)(?![\w{])/g;
// Splits on fenced code blocks and inline code spans so `$` and `\(`/`\[` inside code are never
// touched. A fence segment carries no trailing newline, so the text after it starts mid-line.
const CODE_SPAN_SPLITTER = /(```[\s\S]*?```|`[^`\n]*`)/g;

// LaTeX's own delimiters. CommonMark reads `\(` and `\[` as backslash escapes, so without this the
// parser drops the backslash and prints "( a^2 )". The lookbehind requires an even run of
// backslashes before the delimiter: `\\[2pt]` is a LaTeX line break, not an opening bracket.
const UNESCAPED = String.raw`(?<=(?:^|[^\\])(?:\\\\)*)`;
const INLINE_PAREN_SPAN = new RegExp(String.raw`${UNESCAPED}\\\(([^\n]*?)${UNESCAPED}\\\)`, 'g');
const INLINE_BRACKET_SPAN = new RegExp(String.raw`${UNESCAPED}\\\[([^\n]*?)${UNESCAPED}\\\]`, 'g');
// `\[` opening its line (after indentation or blockquote markers) and `\]` closing a line. The body
// may not cross a blank line, so an unclosed `\[` cannot swallow the paragraphs that follow, nor
// hold another unescaped `\[`/`\]`, so `\[ a \] and \[ b \]` is left to the inline pass instead of
// becoming one broken block. The body consumes backslashes in escape pairs, which keeps it aligned
// so the next `\]` it reaches is unescaped without a per-character lookbehind (that was quadratic
// on a long backslash run).
const OWN_LINE_BRACKET_BLOCK = new RegExp(
  String.raw`^([ \t]*(?:>[ \t]*)*)\\\[((?:\\[^[\]\n]|\\(?=\n)|[^\\\n]|\n(?![ \t>]*\n))*?)\\\][ \t]*$`,
  'gm'
);

// A span's content counts as math if it has a LaTeX control sequence ("\times", "\frac", ...),
// an unambiguous structural math character (^, _, *, parens, braces), or is a bare single-letter
// variable ("$x$"). A lone amount like "$5$" or "$1,000.50$" matches none of these and is left as
// text.
//
// "=", "/", "+", "<", ">" are ambiguous on their own - shell assignment ("$HOME=$PWD"), path
// joins ("$PATH/$SUBDIR") and redirects use them too - so they only count as math evidence when
// followed by another character within the span. Real math always has an operand on both sides
// ("x = 9", "n > 0", "x/y"); the false positives this rejects all dangle the operator as the very
// last character of the content, immediately against the closing "$" (e.g. "$DEBUG=$ true",
// "$PATH/$ as the base"), which is the tell that the "closing" $ is actually the start of an
// unrelated token rather than the end of a math span.
function looksLikeMath(content: string): boolean {
  return (
    /\\[a-zA-Z]/.test(content) || /[_^*(){}]/.test(content) || /^[a-zA-Z]$/.test(content) || /[=/+<>]./.test(content)
  );
}

// `\[x\]` is also how markdown escapes literal brackets, and turndown writes exactly that into
// stored Knowledge files (`\[Smith (2020)\]`, `[\[a\]](#cite)`, `arr\[i\]`, `\[n = 30\]`). So a
// bracket body needs real LaTeX - a control sequence, or `^`, `_` or `=` between operands - and is
// prose when it holds another escaped `_`, `[` or `]`. Without a control sequence it is also prose
// when it has a `:` or a 3+ letter word, or when `^`/`=` is its only evidence and it hugs both
// delimiters: turndown never pads, while models write `\[ x = 1 \]`. A raw `_` still counts when
// tight (`\[a_1\]`) because turndown would have escaped it. Padded `\[ n = 30 \]` stays math: at
// string level it is LaTeX. Parens keep the looser `looksLikeMath`: turndown never escapes them.
function looksLikeBracketMath(raw: string): boolean {
  const content = raw.trim();
  const odd = String.raw`(?:^|[^\\])(?:\\\\)*\\`;
  if (new RegExp(odd + String.raw`[_[\]]`).test(content)) return false;
  if (new RegExp(odd + '[a-zA-Z]').test(content)) return true;
  if (/:|[a-zA-Z]{3}/.test(content)) return false;
  if (/\S\s*_\s*\S/.test(content)) return true;
  const padded = /^\s/.test(raw) && /\s$/.test(raw);
  return padded && /\S\s*[\^=]\s*\S/.test(content);
}

// Models write `\*` so markdown will not italicise a product, but KaTeX has no `\*` command. Scans
// escape pairs left to right so `\\*` (an escaped backslash, then `*`) is left alone.
function unescapeStars(tex: string): string {
  return tex.replace(/\\[\s\S]/g, pair => (pair === '\\*' ? '*' : pair));
}

// Inline `$$...$$` for a one-line span, or the original text when it is not math (`\(sic\)`, the
// markdown-escaped citation `\[1\]`) or holds a `$` that would break the produced delimiters. A
// span touching a `$` or another delimiter gets a space on that side, so `$x$\(y^2\)` does not
// become an unparseable `$x$$$y^2$$`.
function toInlineMath(isMath: (raw: string) => boolean) {
  return (match: string, inner: string, offset: number, whole: string): string => {
    const body = inner.trim();
    if (!body || body.includes('$') || !isMath(inner)) return match;
    const before = whole[offset - 1] === '$' ? ' ' : '';
    const next = whole.slice(offset + match.length, offset + match.length + 2);
    const after = next.startsWith('$') || next === '\\(' || next === '\\[' ? ' ' : '';
    return `${before}$$${unescapeStars(body)}$$${after}`;
  };
}

// remark-math renders `$$` as display math only as a fence: `$$` alone on a line, then content,
// then `$$` alone on a line. A one-line `$$ x $$` renders inline even on its own line. Every fence
// line takes the opening line's prefix so the block stays inside its list item or blockquote.
function toDisplayMath(match: string, prefix: string, inner: string): string {
  if (inner.includes('$') || !looksLikeBracketMath(inner)) return match;
  const [firstLine = '', ...lines] = inner.split('\n');
  // A lazy-continuation line (no `>`) would end the blockquote between the two fences.
  if (prefix.includes('>') && lines.some(line => !/^[ \t]*>/.test(line))) return match;
  const first = firstLine.trim();
  const last = lines.pop();
  const body = [...(first ? [prefix + first] : []), ...lines];
  if (last !== undefined && last.replace(/[\s>]/g, '')) body.push(last.trimEnd());
  return [`${prefix}$$`, ...body.map(unescapeStars), `${prefix}$$`].join('\n');
}

function normalizeLatexBrackets(segment: string, startsLine: boolean, endsLine: boolean): string {
  return segment
    .replace(OWN_LINE_BRACKET_BLOCK, (match: string, prefix: string, inner: string, offset: number) => {
      // `^`/`$` also match at the segment's edges, which sit mid-line next to inline code.
      const atEdge = (offset === 0 && !startsLine) || (offset + match.length === segment.length && !endsLine);
      return atEdge ? match : toDisplayMath(match, prefix, inner);
    })
    .replace(INLINE_BRACKET_SPAN, toInlineMath(looksLikeBracketMath))
    .replace(
      INLINE_PAREN_SPAN,
      toInlineMath(raw => looksLikeMath(raw.trim()))
    );
}

/**
 * Normalizes LLM math into the `$$` forms `remark-math` renders, before markdown is parsed:
 * - single-dollar spans (`$17 \times 24$`, `$x^2 = 9$`) become inline `$$...$$`, so they render
 *   even with `singleDollarTextMath: false` (see `remarkGfmNoSingleTilde` above for why that is off);
 * - LaTeX `\( ... \)` becomes inline `$$...$$`;
 * - LaTeX `\[ ... \]` becomes a fenced, centred `$$` block when it opens and closes its own lines,
 *   and inline `$$...$$` when it sits mid-sentence (splitting the sentence would be worse).
 * remark-math treats a `$$...$$` span embedded mid-sentence as inline, so the inline rewrites
 * change how genuine LaTeX renders, not layout.
 *
 * A dollar span is promoted when it matches `SINGLE_DOLLAR_SPAN`'s currency-safe delimiter shape
 * AND its content passes `looksLikeMath`. Together these catch math with no backslash command
 * (`$x^2$`, `$n > 0$`, `$f(x)$`, `$a_1, a_2$`) while still leaving currency prose ("$124 and
 * $150 per seat", "$5 to $10", "$20/month") as literal text. `\( \)` spans pass `looksLikeMath`
 * too; `\[ \]` spans pass the stricter `looksLikeBracketMath`, so markdown-escaped brackets like
 * `\[1\]` or `\[Smith (2020)\]` stay literal.
 *
 * Use this in every renderer that displays LLM / AI-generated markdown so the behavior stays
 * consistent and the fix does not drift across surfaces.
 */
export function promoteInlineLatexDollars(markdown: string): string {
  const segments = markdown.split(CODE_SPAN_SPLITTER);
  return segments
    .map((segment, i) =>
      i % 2 === 1
        ? segment
        : normalizeLatexBrackets(segment, i === 0, i === segments.length - 1).replace(
            SINGLE_DOLLAR_SPAN,
            (match, inner: string) => (looksLikeMath(inner) ? `$$${inner}$$` : match)
          )
    )
    .join('');
}

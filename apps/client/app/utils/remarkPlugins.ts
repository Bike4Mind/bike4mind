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
// Splits on fenced code blocks and inline code spans so `$` inside code is never touched.
const CODE_SPAN_SPLITTER = /(```[\s\S]*?```|`[^`\n]*`)/g;

// A span's content counts as math if it has a LaTeX control sequence ("\times", "\frac", ...),
// a structural math character (^, _, =, <, >, +, *, /, parens, braces), or is a bare
// single-letter variable ("$x$"). A lone amount like "$5$" or "$1,000.50$" matches none of these
// and is left as text.
function looksLikeMath(content: string): boolean {
  return /\\[a-zA-Z]/.test(content) || /[_^=<>+*/(){}]/.test(content) || /^[a-zA-Z]$/.test(content);
}

/**
 * Promotes single-dollar math spans (`$17 \times 24$`, `$x^2 = 9$`) to double-dollar spans
 * (`$$...$$`) before markdown is parsed, so `remark-math` renders them as inline math even with
 * `singleDollarTextMath: false` (see `remarkGfmNoSingleTilde` above for why that option is off).
 * remark-math treats `$$...$$` as inline vs. block based on position - a span embedded
 * mid-sentence stays inline - so this only changes how genuine LaTeX renders, not layout.
 *
 * A span is promoted when it matches `SINGLE_DOLLAR_SPAN`'s currency-safe delimiter shape AND
 * its content passes `looksLikeMath`. Together these catch math with no backslash command
 * (`$x^2$`, `$n > 0$`, `$f(x)$`, `$a_1, a_2$`) while still leaving currency prose ("$124 and
 * $150 per seat", "$5 to $10", "$20/month") as literal text.
 *
 * Use this in every renderer that displays LLM / AI-generated markdown so the behavior stays
 * consistent and the fix does not drift across surfaces.
 */
export function promoteInlineLatexDollars(markdown: string): string {
  return markdown
    .split(CODE_SPAN_SPLITTER)
    .map((segment, i) =>
      i % 2 === 1
        ? segment
        : segment.replace(SINGLE_DOLLAR_SPAN, (match, inner: string) => (looksLikeMath(inner) ? `$$${inner}$$` : match))
    )
    .join('');
}

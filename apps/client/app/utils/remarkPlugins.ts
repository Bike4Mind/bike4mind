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

// Matches a single-dollar span with no nested/adjacent `$` and no newline, requiring at least
// one LaTeX control sequence (`\command`) inside - this is what distinguishes real inline math
// ("$17 \times 24$") from ordinary currency prose ("$124 and $150"), which never contains a
// backslash command.
const SINGLE_DOLLAR_LATEX_SPAN = /(?<!\$)\$(?!\$)([^$\n]*\\[a-zA-Z][^$\n]*)(?<!\$)\$(?!\$)/g;
// Splits on fenced code blocks and inline code spans so `$` inside code is never touched.
const CODE_SPAN_SPLITTER = /(```[\s\S]*?```|`[^`\n]*`)/g;

/**
 * Promotes single-dollar LaTeX spans (`$17 \times 24$`) to double-dollar spans
 * (`$$17 \times 24$$`) before markdown is parsed, so `remark-math` renders them as inline math
 * even with `singleDollarTextMath: false` (see `remarkGfmNoSingleTilde` above for why that
 * option is off). remark-math treats `$$...$$` as inline vs. block based on position - a span
 * embedded mid-sentence stays inline - so this only changes how genuine LaTeX renders, not
 * layout.
 *
 * Only spans containing a `\command` are promoted, so plain currency text ("$124 and $150 per
 * seat") is left untouched. This is deliberately narrower than "any `$...$` pair": it won't
 * catch LaTeX with no backslash command (e.g. `$x^2$`), but that tradeoff is what keeps currency
 * prose safe. LLMs almost always reach for a backslash command (`\times`, `\frac`, `\sqrt`, a
 * greek letter, ...) in real math, so this covers the common case.
 *
 * Use this in every renderer that displays LLM / AI-generated markdown so the behavior stays
 * consistent and the fix does not drift across surfaces.
 */
export function promoteInlineLatexDollars(markdown: string): string {
  return markdown
    .split(CODE_SPAN_SPLITTER)
    .map((segment, i) =>
      i % 2 === 1 ? segment : segment.replace(SINGLE_DOLLAR_LATEX_SPAN, (_match, inner: string) => `$$${inner}$$`)
    )
    .join('');
}

import { parseRate, plain, tables, type ParseResult } from './markdown';

/**
 * Parsers for OpenAI's published markdown twins: the pricing page, and a model's
 * own page. Together they are the only place OpenAI states its prices as data -
 * /v1/models is four fields wide (see openai.ts) - so without them every OpenAI
 * price depends on two third-party mirrors agreeing.
 */

export const OPENAI_PRICING_URL = 'https://platform.openai.com/docs/pricing.md';

export const openAiModelDocUrl = (modelId: string): string =>
  `https://platform.openai.com/docs/models/${encodeURIComponent(modelId)}.md`;

/**
 * The heading over the pay-as-you-go table. The page carries four tables with
 * BYTE-IDENTICAL headers - Standard, Batch, Flex and Fast - and Batch is exactly
 * half of Standard, so a selector that fell through to the next matching table
 * would halve every OpenAI price with nothing to show for it. Selection is by
 * heading and fails closed.
 */
const STANDARD_HEADING = /^standard pricing/i;

/** Columns are matched by name; a renamed one fails the parse rather than shifting. */
const COLUMNS = {
  shortInput: /^short context input$/i,
  shortCacheRead: /^short context cached input$/i,
  shortCacheWrite: /^short context cache writes$/i,
  shortOutput: /^short context output$/i,
  longInput: /^long context input$/i,
  longCacheRead: /^long context cached input$/i,
  longCacheWrite: /^long context cache writes$/i,
  longOutput: /^long context output$/i,
} as const;

/** One rate set as the page publishes it, in USD per 1M tokens. */
export interface OpenAiRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface OpenAiPriceRow extends OpenAiRates {
  /** The API model id, which is what the table is keyed by - no slugging needed. */
  modelId: string;
  /**
   * What a prompt past the breakpoint pays. Present only when the row publishes
   * both a long-context input AND output rate: half a bracket is not a bracket.
   */
  longContext?: OpenAiRates;
  /**
   * Input tokens the long-context rates start above, when the model cell states
   * it inline ("gpt-5.5 (<272K context length)"). The newer families drop the
   * annotation and state it on their own page instead, which is what
   * parseOpenAiLongContextBreakpoint reads.
   */
  longContextAboveTokens?: number;
}

/** "272K" -> 272000, "1.05M" -> 1050000, "272,000" -> 272000. Integers only. */
export function parseTokenCount(value: string): number | undefined {
  const match = /([\d,]+(?:\.\d+)?)\s*([km])?/i.exec(value.trim());
  if (!match) return undefined;
  const digits = Number(match[1]?.replace(/,/g, ''));
  if (!Number.isFinite(digits) || digits <= 0) return undefined;
  const scale = match[2]?.toLowerCase() === 'k' ? 1_000 : match[2]?.toLowerCase() === 'm' ? 1_000_000 : 1;
  const tokens = digits * scale;
  return Number.isInteger(tokens) ? tokens : undefined;
}

/**
 * "gpt-5.5 (<272K context length)" -> the id plus the breakpoint that qualifies
 * it. The annotation is stripped along with every other parenthetical the page
 * hangs off a name, because what is left has to be the id verbatim: OpenAI ids
 * carry dots and dashes ("gpt-5.6-luna", "gpt-4o-2024-05-13") and re-shaping one
 * would join to nothing.
 */
export function parseOpenAiModelCell(cell: string): { modelId: string; longContextAboveTokens?: number } | null {
  const value = plain(cell);
  const annotated = /\(\s*<\s*([\d.,]+\s*[km]?)\s*(?:input\s*)?(?:token\s*)?context length\s*\)/i.exec(value);
  const modelId = value.replace(/\([^)]*\)/g, '').trim();
  // Conservative id shape: the table also carries prose rows ("Fine-tuning", a
  // footnote) in some sections, and one of those joining to a model would price it.
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(modelId)) return null;
  const longContextAboveTokens = annotated ? parseTokenCount(annotated[1] ?? '') : undefined;
  return longContextAboveTokens === undefined ? { modelId } : { modelId, longContextAboveTokens };
}

/**
 * The Standard pricing table. Rates a row leaves as "-" are absent rather than
 * zero: pricePlan reads a published 0 as free and an absent rate as "carry the
 * one in force forward", and only the second is true here.
 */
export function parseOpenAiPricing(markdown: string): ParseResult<OpenAiPriceRow> {
  const all = tables(markdown);
  if (all.length === 0) return { ok: false, error: 'pricing.md contained no tables' };

  const table = all.find(candidate => STANDARD_HEADING.test(candidate.heading));
  if (!table) return { ok: false, error: 'pricing.md has no "Standard pricing" table' };

  const column = (pattern: RegExp) => table.headers.findIndex(header => pattern.test(plain(header)));
  const at = {
    shortInput: column(COLUMNS.shortInput),
    shortCacheRead: column(COLUMNS.shortCacheRead),
    shortCacheWrite: column(COLUMNS.shortCacheWrite),
    shortOutput: column(COLUMNS.shortOutput),
    longInput: column(COLUMNS.longInput),
    longCacheRead: column(COLUMNS.longCacheRead),
    longCacheWrite: column(COLUMNS.longCacheWrite),
    longOutput: column(COLUMNS.longOutput),
  };

  // The two the row cannot be read without. A renamed cache or long-context
  // column instead drops that rate, which pricePlan handles as "not published":
  // it carries the rate in force forward rather than moving it.
  if (at.shortInput < 0 || at.shortOutput < 0) {
    return { ok: false, error: 'pricing.md Standard table is missing an expected column' };
  }

  const rows: OpenAiPriceRow[] = [];
  for (const row of table.rows) {
    const parsed = parseOpenAiModelCell(row[0] ?? '');
    const rates = ratesAt(row, at.shortInput, at.shortOutput, at.shortCacheRead, at.shortCacheWrite);
    if (!parsed || !rates) continue;

    const longContext = ratesAt(row, at.longInput, at.longOutput, at.longCacheRead, at.longCacheWrite);
    rows.push({ ...parsed, ...rates, ...(longContext ? { longContext } : {}) });
  }

  if (rows.length === 0) return { ok: false, error: 'pricing.md Standard table yielded zero rows' };
  return { ok: true, rows };
}

/** A rate group, or nothing when either of its two required rates is unpublished. */
function ratesAt(
  row: readonly string[],
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number
): OpenAiRates | undefined {
  const inputPerMTok = input < 0 ? undefined : parseRate(row[input] ?? '');
  const outputPerMTok = output < 0 ? undefined : parseRate(row[output] ?? '');
  if (inputPerMTok === undefined || outputPerMTok === undefined) return undefined;

  const rates: OpenAiRates = { inputPerMTok, outputPerMTok };
  const cacheReadPerMTok = cacheRead < 0 ? undefined : parseRate(row[cacheRead] ?? '');
  const cacheWritePerMTok = cacheWrite < 0 ? undefined : parseRate(row[cacheWrite] ?? '');
  if (cacheReadPerMTok !== undefined) rates.cacheReadPerMTok = cacheReadPerMTok;
  if (cacheWritePerMTok !== undefined) rates.cacheWritePerMTok = cacheWritePerMTok;
  return rates;
}

/**
 * The long-context breakpoint off a model's own page, from the bullet under its
 * pricing table: "Prompts with >272K input tokens are priced at 2x input and 1.5x
 * output for the full request." The same sentence appears in a longer form on the
 * older families ("For models with a 1.05M context window (GPT-5.4 and GPT-5.4
 * Pro), prompts with >272K input tokens are ..."), so the match anchors on the
 * clause rather than on the line.
 *
 * Undefined means the page does not state one, which is a model this source may
 * not price at all - see openai.ts.
 */
export function parseOpenAiLongContextBreakpoint(markdown: string): number | undefined {
  const match = /prompts with\s*>\s*([\d.,]+\s*[km]?)\s*input tokens/i.exec(markdown);
  return match ? parseTokenCount(match[1] ?? '') : undefined;
}

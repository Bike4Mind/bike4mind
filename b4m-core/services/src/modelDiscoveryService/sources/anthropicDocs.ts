import type { ModelRecord } from '@bike4mind/common';

/**
 * Parsers for Anthropic's two published markdown twins: `model-deprecations.md`
 * (the only typed lifecycle feed a direct provider gives us) and `pricing.md`.
 *
 * Both return `{ ok: false }` when they find valid markdown and zero rows. "The
 * page rendered and I found nothing" is the shape of a parser that broke against
 * a docs restructure, not of a provider that retired everything (sec 5.5), and
 * an empty success here would freeze every Claude lifecycle field at once.
 */
export type ParseResult<T> = { ok: true; rows: T[] } | { ok: false; error: string };

export const ANTHROPIC_DEPRECATIONS_URL = 'https://docs.claude.com/en/docs/about-claude/model-deprecations.md';
export const ANTHROPIC_PRICING_URL = 'https://docs.claude.com/en/docs/about-claude/pricing.md';

interface MarkdownTable {
  heading: string;
  headers: string[];
  rows: string[][];
}

const MONTHS: Readonly<Record<string, string>> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

const cells = (line: string): string[] =>
  line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(cell => cell.trim());

const isSeparator = (line: string): boolean => /^\s*\|[\s:|-]+\|\s*$/.test(line);

/** Every pipe table in the document, tagged with the nearest preceding heading. */
function tables(markdown: string): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/);
  const found: MarkdownTable[] = [];
  let heading = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch) {
      heading = (headingMatch[1] ?? '').trim();
      continue;
    }
    if (!line.trimStart().startsWith('|') || !isSeparator(lines[index + 1] ?? '')) continue;

    const headers = cells(line);
    const rows: string[][] = [];
    index += 2;
    while (index < lines.length && (lines[index] ?? '').trimStart().startsWith('|')) {
      rows.push(cells(lines[index] ?? ''));
      index += 1;
    }
    index -= 1;
    found.push({ heading, headers, rows });
  }

  return found;
}

/** "June 9, 2027" -> "2027-06-09". Undefined for "N/A", "TBD" and anything else. */
export function parseLongDate(value: string): string | undefined {
  const match = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(value);
  const month = MONTHS[(match?.[1] ?? '').toLowerCase()];
  if (!match || !month) return undefined;
  return `${match[3]}-${month}-${String(match[2]).padStart(2, '0')}`;
}

/** Strip inline links and code ticks, keeping the link text: docs pages are MDX. */
const plain = (value: string): string =>
  value
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim();

export interface AnthropicLifecycleRow {
  modelId: string;
  status: NonNullable<ModelRecord['lifecycle']>['status'];
  deprecationDate?: string;
  retirementDate?: string;
  replacedBy?: string;
}

const STATUS_BY_LABEL: Readonly<Record<string, AnthropicLifecycleRow['status']>> = {
  active: 'active',
  legacy: 'legacy',
  deprecated: 'deprecated',
  retired: 'retired',
};

/**
 * The "Model status" table plus the "Deprecation history" tables that name a
 * replacement. A retirement date is recorded only for a model that is actually
 * deprecated or retired: for an active model the column reads "Not sooner than
 * <date>", which is a floor Anthropic may move, and writing it as a retirement
 * date would have the picker warn about models nobody is retiring.
 */
export function parseAnthropicDeprecations(markdown: string): ParseResult<AnthropicLifecycleRow> {
  const all = tables(markdown);
  if (all.length === 0) return { ok: false, error: 'model-deprecations.md contained no tables' };

  const statusTable = all.find(table => /api model name/i.test(table.headers[0] ?? ''));
  if (!statusTable) return { ok: false, error: 'model-deprecations.md has no "API model name" table' };

  const replacements = new Map<string, string>();
  for (const table of all) {
    const modelColumn = table.headers.findIndex(header => /deprecated model/i.test(header));
    const replacementColumn = table.headers.findIndex(header => /replacement/i.test(header));
    if (modelColumn < 0 || replacementColumn < 0) continue;
    for (const row of table.rows) {
      const modelId = plain(row[modelColumn] ?? '');
      const replacedBy = plain(row[replacementColumn] ?? '');
      // First writer wins: the history is newest-first, so the newest advice for
      // a model that has been re-pointed more than once is the one kept.
      if (modelId && replacedBy && !replacements.has(modelId)) replacements.set(modelId, replacedBy);
    }
  }

  const stateColumn = statusTable.headers.findIndex(header => /current state/i.test(header));
  const deprecatedColumn = statusTable.headers.findIndex(header => /^deprecated$/i.test(header));
  const retirementColumn = statusTable.headers.findIndex(header => /retirement/i.test(header));

  const rows: AnthropicLifecycleRow[] = [];
  for (const row of statusTable.rows) {
    const modelId = plain(row[0] ?? '');
    const status = STATUS_BY_LABEL[plain(row[stateColumn] ?? '').toLowerCase()];
    if (!modelId || !status) continue;

    const retired = status === 'deprecated' || status === 'retired';
    rows.push({
      modelId,
      status,
      deprecationDate: parseLongDate(row[deprecatedColumn] ?? ''),
      retirementDate: retired ? parseLongDate(row[retirementColumn] ?? '') : undefined,
      replacedBy: replacements.get(modelId),
    });
  }

  if (rows.length === 0) return { ok: false, error: 'model-deprecations.md status table yielded zero rows' };
  return { ok: true, rows };
}

export interface AnthropicPriceRow {
  /** Display name slugged to id shape: "Claude Opus 4.5" -> "claude-opus-4-5". */
  slug: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /** Inclusive last day this row's rate applies, from a "through <date>" note. */
  validUntil?: string;
  /** First day this row's rate applies, from a "starting <date>" note. */
  validFrom?: string;
}

/** "$12.50 / MTok" -> 12.5. Undefined for "N/A" and for anything without a figure. */
function parseRate(cell: string): number | undefined {
  const match = /\$\s*([\d,]+(?:\.\d+)?)/.exec(plain(cell));
  if (!match) return undefined;
  const value = Number(match[1]?.replace(/,/g, ''));
  return Number.isFinite(value) ? value : undefined;
}

/** "Claude Sonnet 5 through August 31, 2026" -> slug + the box that qualifies it. */
export function parseModelCell(cell: string): { slug: string; validUntil?: string; validFrom?: string } | null {
  let value = plain(cell);

  let validUntil: string | undefined;
  let validFrom: string | undefined;
  const through = /\bthrough\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/i.exec(value);
  if (through) {
    validUntil = parseLongDate(through[1] ?? '');
    value = value.replace(through[0], '');
  }
  const starting = /\bstarting\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/i.exec(value);
  if (starting) {
    validFrom = parseLongDate(starting[1] ?? '');
    value = value.replace(starting[0], '');
  }

  // Drop annotations the docs hang off the name: "(deprecated)",
  // "(retired, except on Bedrock and Google Cloud)", "(limited availability)".
  const slug = value
    .replace(/\([^)]*\)/g, '')
    .trim()
    .toLowerCase()
    .replace(/[.\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return slug.length > 0 ? { slug, validUntil, validFrom } : null;
}

/**
 * The "Model pricing" table. Keyed by display name, because that is what the
 * page publishes - the id join happens in the source, against the ids
 * /v1/models actually returned, so a name we cannot place is simply unpriced.
 */
export function parseAnthropicPricing(markdown: string): ParseResult<AnthropicPriceRow> {
  const all = tables(markdown);
  if (all.length === 0) return { ok: false, error: 'pricing.md contained no tables' };

  const table = all.find(
    candidate => /^model$/i.test(candidate.headers[0] ?? '') && candidate.headers.some(h => /base input/i.test(h))
  );
  if (!table) return { ok: false, error: 'pricing.md has no "Base Input Tokens" table' };

  const inputColumn = table.headers.findIndex(header => /base input/i.test(header));
  const outputColumn = table.headers.findIndex(header => /output tokens/i.test(header));

  const rows: AnthropicPriceRow[] = [];
  for (const row of table.rows) {
    const parsed = parseModelCell(row[0] ?? '');
    const inputPerMTok = parseRate(row[inputColumn] ?? '');
    const outputPerMTok = parseRate(row[outputColumn] ?? '');
    if (!parsed || inputPerMTok === undefined || outputPerMTok === undefined) continue;
    rows.push({ ...parsed, inputPerMTok, outputPerMTok });
  }

  if (rows.length === 0) return { ok: false, error: 'pricing.md model table yielded zero rows' };
  return { ok: true, rows };
}

/**
 * The row in force on `at`. Time-boxed rows are real - Sonnet 5 has introductory
 * pricing through 2026-08-31 and a higher rate from 2026-09-01 - so a run must
 * pick by its own clock rather than by document order.
 */
export function priceInForce(
  rows: readonly AnthropicPriceRow[],
  slug: string,
  at: Date
): AnthropicPriceRow | undefined {
  const day = at.toISOString().slice(0, 10);
  const candidates = rows.filter(
    row =>
      row.slug === slug &&
      (row.validFrom === undefined || row.validFrom <= day) &&
      (row.validUntil === undefined || row.validUntil >= day)
  );
  // Prefer the bounded row: an unbounded row is the standing rate, and a bounded
  // one that also matches is the exception that currently overrides it.
  return candidates.find(row => row.validUntil !== undefined || row.validFrom !== undefined) ?? candidates[0];
}

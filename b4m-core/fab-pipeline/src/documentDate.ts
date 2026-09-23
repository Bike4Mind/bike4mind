import type { DocumentDateSource } from '@bike4mind/common';

/** A vintage we are willing to store, with the provenance that earned it. */
export type ExtractedDocumentDate = { date: Date; source: DocumentDateSource };

/**
 * Earliest vintage we treat as a real signal.
 *
 * The producers we read from all have a "zero" that parses as a perfectly valid date: Windows
 * FILETIME zero is 1601-01-01, the Unix epoch is 1970-01-01, and the zip/OOXML epoch is 1980-01-01.
 * A born-digital document predating 1980 is vanishingly rare, and a digitised older document gets
 * its SCAN date in metadata rather than its authored one, so nothing real is lost by refusing the
 * whole range - whereas admitting it means shipping "dated 1601-01-01" into a passage header.
 */
const EARLIEST_PLAUSIBLE_DOCUMENT_DATE = Date.UTC(1980, 0, 1);

/** Tolerance for a writer's clock running ahead of ours. Beyond this, a future date is a broken clock. */
const FUTURE_SKEW_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * Only the leading bytes of a text file are scanned for frontmatter. A file whose first block is
 * not frontmatter should cost a few hundred bytes to rule out, not a full pass over the document.
 */
const FRONTMATTER_SCAN_LIMIT_BYTES = 8 * 1024;

/** Frontmatter keys that denote the document's own date, in descending order of directness. */
const FRONTMATTER_DATE_KEYS = ['date', 'published', 'publishdate', 'pubdate', 'created'] as const;

type FrontmatterDateKey = (typeof FRONTMATTER_DATE_KEYS)[number];

/**
 * Every accepted spelling of those keys, mapped to the canonical one, matched after lowercasing.
 *
 * Enumerated rather than normalised by stripping `_` and `-` from the key: that strip also folds
 * `d_ate`, `_date` and `d-a-t-e` into `date`, so a typo'd or deliberately-odd key would be read as
 * the document's vintage. Every separator style a writer actually uses is here instead.
 */
const FRONTMATTER_DATE_KEY_SPELLINGS = new Map<string, FrontmatterDateKey>([
  ['date', 'date'],
  ['published', 'published'],
  ['publishdate', 'publishdate'],
  ['publish_date', 'publishdate'],
  ['publish-date', 'publishdate'],
  ['pubdate', 'pubdate'],
  ['pub_date', 'pubdate'],
  ['pub-date', 'pubdate'],
  ['created', 'created'],
]);

/**
 * Is this a date we are willing to present as a document's vintage?
 *
 * The bar is deliberately "a real signal or nothing" (#3048): a wrong date in a passage header is
 * worse than an absent one, because the model has no way to tell that it is wrong. Everything that
 * fails here is dropped silently by design - an unset metadata slot is the normal case for most
 * documents, not an error worth logging once per file.
 */
export function isPlausibleDocumentDate(date: Date, now: number = Date.now()): boolean {
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return false;
  return ms >= EARLIEST_PLAUSIBLE_DOCUMENT_DATE && ms <= now + FUTURE_SKEW_TOLERANCE_MS;
}

/**
 * Parse a leading ISO-8601 date, with or without a time part.
 *
 * Anchored to `YYYY-MM-DD` rather than handed to `new Date(...)` raw: the Date constructor's
 * non-ISO fallback is implementation-defined, and it happily turns "Q3 budget" or "12" into a date
 * on some engines. A vintage sourced from a guess is exactly what this field must not carry.
 *
 * Any trailing zone designator is outside the match and so has no effect: the instant carries the
 * wall-clock day the producer wrote, which is the day the header renders. `parsePdfInfoDate` holds
 * the same contract deliberately - see the reasoning there.
 */
function parseIsoDatePrefix(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour ?? '0'),
    Number(minute ?? '0'),
    Number(second ?? '0')
  );
  const date = new Date(ms);
  // Date.UTC rolls overflow forward (month 13 becomes January of the next year), so a round-trip
  // check is what rejects "2019-13-45" rather than silently shifting it. The YEAR is round-tripped
  // for a different reason: Date.UTC maps a two-digit year onto 1900-1999, so "0099-03-04" would
  // otherwise become a perfectly plausible 1999-03-04 and sail through the window below.
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return date;
}

/**
 * Parse a PDF info-dictionary date (PDF 32000-1, 7.9.4): `D:YYYYMMDDHHmmSSOHH'mm'`, where every
 * part after the year is optional and `O` is `+`, `-` or `Z`.
 *
 * Producers are loose with this: the `D:` prefix is often missing, the offset is often absent or
 * truncated, and an unset slot is frequently written out as all zeros. Anything that does not yield
 * a real calendar date comes back null and is dropped by the caller.
 *
 * The trailing UTC offset is matched and then DELIBERATELY IGNORED, so the instant carries the
 * wall-clock date the producer wrote. This field is rendered as a bare `YYYY-MM-DD` day
 * (formatDocumentDate, renderRetrievedContentBlock.ts), so shifting the instant into true UTC
 * moves the RENDERED DAY off the one the document claims: `D:20190304000000+08'00'` would print
 * 2019-03-03. `parseIsoDatePrefix` - the parser behind OOXML, frontmatter and .xls - already
 * ignores offsets, so ignoring it here is what makes one authored date render the same whatever
 * format it arrived in. It also keeps a genuine `D:19800101000000+01'00'` inside the plausibility
 * floor instead of nudging it an hour below 1980.
 */
export function parsePdfInfoDate(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const match = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:Z|[+-]\d{2}'?(?:\d{2})?)?/.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;

  // Month and day must be PRESENT and non-zero. Producers spell "unset" both ways - omitting the
  // field entirely (`D:2019`) and writing it out as zeros (`D:20190000`) - and both mean the same
  // thing, so both are refused the same way. Defaulting either to 01 would invent a January 1st,
  // and the header renders YYYY-MM-DD, so that invented day reaches the model looking day-precise.
  // This is also what `parseIsoDatePrefix` already requires of the other two formats.
  if (!month || !day) return null;
  const monthIndex = Number(month) - 1;
  const dayOfMonth = Number(day);
  if (monthIndex < 0 || dayOfMonth < 1) return null;

  const date = new Date(
    Date.UTC(Number(year), monthIndex, dayOfMonth, Number(hour ?? '0'), Number(minute ?? '0'), Number(second ?? '0'))
  );
  // Year included for the same reason as in parseIsoDatePrefix: `D:00990304` would otherwise be
  // remapped to a credible 1999-03-04 by Date.UTC's two-digit-year rule.
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== dayOfMonth) {
    return null;
  }
  return date;
}

/**
 * Pull `dcterms:created` out of an OOXML `docProps/core.xml` (the authored date Word, Excel and
 * PowerPoint stamp on save). Falls back to `dc:date`, which some producers write instead.
 */
export function parseOoxmlCoreCreated(xml: string): Date | null {
  const created = /<(?:dcterms:)?created\b[^>]*>([^<]+)<\/(?:dcterms:)?created>/i.exec(xml);
  const dcDate = /<dc:date\b[^>]*>([^<]+)<\/dc:date>/i.exec(xml);
  // Both are parsed, not just the first that MATCHES: a producer writing a locale date into
  // dcterms:created would otherwise suppress a well-formed dc:date sitting right beside it.
  return (created && parseIsoDatePrefix(created[1])) ?? (dcDate ? parseIsoDatePrefix(dcDate[1]) : null);
}

/**
 * Pull a document date out of a leading YAML frontmatter block.
 *
 * Hand-scanned rather than handed to a YAML parser: the only thing wanted here is a scalar date on
 * a top-level key of the first block, and that does not justify pulling a YAML dependency into the
 * ingest bundle. Anything structurally richer than `key: value` is simply not matched, which is the
 * right outcome for a field that must hold a real signal or nothing.
 */
export function parseFrontmatterDate(text: string): Date | null {
  const head = text.slice(0, FRONTMATTER_SCAN_LIMIT_BYTES);
  const block = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(head);
  if (!block) return null;

  const found = new Map<string, Date>();
  for (const line of block[1].split(/\r?\n/)) {
    // Top-level keys only: an indented line belongs to a nested mapping, where `date` means
    // something else (a nested object's own field), not the document's vintage.
    const pair = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.+?)[ \t]*$/.exec(line);
    if (!pair) continue;
    const key = FRONTMATTER_DATE_KEY_SPELLINGS.get(pair[1].toLowerCase());
    if (!key || found.has(key)) continue;
    const parsed = parseIsoDatePrefix(pair[2].replace(/^['"]|['"]$/g, ''));
    if (parsed) found.set(key, parsed);
  }

  for (const key of FRONTMATTER_DATE_KEYS) {
    const hit = found.get(key);
    if (hit) return hit;
  }
  return null;
}

/**
 * Funnel every extractor goes through: a candidate only becomes a stored vintage if it survives
 * the plausibility window. Keeping this in one place is what stops a new extractor from quietly
 * skipping the check.
 */
export function acceptDocumentDate(
  date: Date | string | null | undefined,
  source: DocumentDateSource,
  now: number = Date.now()
): ExtractedDocumentDate | undefined {
  // A string is accepted because a producer's TYPES can lie: SheetJS declares Props.CreatedDate as
  // Date, but its BIFF8 (.xls) reader hands back an ISO string - which reached getTime() as a
  // TypeError and cost the file every one of its chunks, not just its vintage. Normalising here
  // rather than at each call site is the same reason the plausibility check lives here.
  // Strings go through the anchored ISO parser, never `new Date(...)`, so a non-date string is
  // refused rather than guessed at.
  const parsed = typeof date === 'string' ? parseIsoDatePrefix(date) : date;
  if (!parsed || !isPlausibleDocumentDate(parsed, now)) return undefined;
  return { date: parsed, source };
}

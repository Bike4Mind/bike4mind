import { describe, expect, it } from 'vitest';
import { DocumentDateSource } from '@bike4mind/common';
import {
  acceptDocumentDate,
  isPlausibleDocumentDate,
  parseFrontmatterDate,
  parseOoxmlCoreCreated,
  parsePdfInfoDate,
} from './documentDate';

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** What `formatDocumentDate` prints into a passage header - the only form the model ever sees. */
const renderedDay = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;

describe('isPlausibleDocumentDate', () => {
  const now = Date.UTC(2026, 8, 23);

  it('accepts a date inside the window', () => {
    expect(isPlausibleDocumentDate(new Date('2019-03-04T00:00:00Z'), now)).toBe(true);
  });

  // The producers' "unset" spellings. Each parses as a valid calendar date, which is exactly why
  // the window exists - without it every one of these reaches a passage header as a real vintage.
  it.each([
    ['Windows FILETIME zero', '1601-01-01T00:00:00Z'],
    ['Unix epoch zero', '1970-01-01T00:00:00Z'],
    ['year zero', '0000-01-01T00:00:00Z'],
  ])('rejects %s', (_label, value) => {
    expect(isPlausibleDocumentDate(new Date(value), now)).toBe(false);
  });

  it('accepts the 1980 boundary itself', () => {
    expect(isPlausibleDocumentDate(new Date('1980-01-01T00:00:00Z'), now)).toBe(true);
  });

  it('rejects a date beyond clock-skew tolerance, but allows a slightly fast clock', () => {
    expect(isPlausibleDocumentDate(new Date(now + 2 * 24 * 60 * 60 * 1000), now)).toBe(false);
    expect(isPlausibleDocumentDate(new Date(now + 60 * 60 * 1000), now)).toBe(true);
  });

  it('rejects an invalid Date rather than throwing', () => {
    expect(isPlausibleDocumentDate(new Date('nonsense'), now)).toBe(false);
  });
});

describe('parsePdfInfoDate', () => {
  it('parses the Z form and a bare date with no D: prefix', () => {
    expect(iso(parsePdfInfoDate('D:20190304123000Z'))).toBe('2019-03-04T12:30:00.000Z');
    expect(iso(parsePdfInfoDate('20190304'))).toBe('2019-03-04T00:00:00.000Z');
  });

  // The offset is consumed by the pattern and then ignored, so the instant keeps the wall-clock
  // day the producer wrote. Applying it would build a true UTC instant whose UTC DAY - the only
  // part that reaches the model - is not the day the document claims.
  it.each([
    ['positive offset', "D:20190304123000+02'00'"],
    ['negative offset', "D:20190304123000-05'00'"],
    ['offset with no minutes', 'D:20190304123000+02'],
    ['no offset at all', 'D:20190304123000'],
  ])('ignores the UTC offset: %s', (_label, value) => {
    expect(iso(parsePdfInfoDate(value))).toBe('2019-03-04T12:30:00.000Z');
  });

  // The failure this guards is a rendered one, so it is pinned on the rendered day rather than on
  // the instant: both of these used to print the neighbouring calendar day.
  it.each([
    ['midnight at a positive offset', "D:20190304000000+08'00'"],
    ['late evening at a negative offset', "D:20190304230000-05'00'"],
  ])('renders the authored calendar day: %s', (_label, value) => {
    expect(renderedDay(parsePdfInfoDate(value))).toBe('2019-03-04');
  });

  // Same reason: an offset applied here would push this an hour under the 1980 floor and the
  // document would silently lose a vintage it genuinely carries.
  it('keeps an offset date at the plausibility floor inside the window', () => {
    expect(isPlausibleDocumentDate(parsePdfInfoDate("D:19800101000000+01'00'")!)).toBe(true);
  });

  // The two spellings of "unset" a producer can use, and they must behave identically: defaulting
  // either to 01 invents a January 1st, which the YYYY-MM-DD header then presents as day-precise.
  it.each([
    ['all-zero month and day', 'D:20190000000000'],
    ['all-zero day', 'D:20190300000000'],
    ['year only', 'D:2019'],
    ['year and month only', 'D:201903'],
  ])('rejects %s rather than defaulting to January 1st', (_label, value) => {
    expect(parsePdfInfoDate(value)).toBeNull();
  });

  it('rejects an impossible calendar date instead of rolling it forward', () => {
    expect(parsePdfInfoDate('D:20191345000000')).toBeNull();
  });

  it('returns null for a non-string or unparseable value', () => {
    expect(parsePdfInfoDate(undefined)).toBeNull();
    expect(parsePdfInfoDate(new Date())).toBeNull();
    expect(parsePdfInfoDate('not a date')).toBeNull();
  });
});

describe('parseOoxmlCoreCreated', () => {
  const coreXml = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties>${body}</cp:coreProperties>`;

  it('reads dcterms:created', () => {
    const xml = coreXml('<dcterms:created xsi:type="dcterms:W3CDTF">2019-03-04T09:15:00Z</dcterms:created>');
    expect(iso(parseOoxmlCoreCreated(xml))).toBe('2019-03-04T09:15:00.000Z');
  });

  it('prefers created over a dc:date fallback when both are present', () => {
    const xml = coreXml(
      '<dc:date>2021-06-06T00:00:00Z</dc:date>' +
        '<dcterms:created xsi:type="dcterms:W3CDTF">2019-03-04T09:15:00Z</dcterms:created>'
    );
    expect(iso(parseOoxmlCoreCreated(xml))).toBe('2019-03-04T09:15:00.000Z');
  });

  it('falls back to dc:date when there is no created element', () => {
    expect(iso(parseOoxmlCoreCreated(coreXml('<dc:date>2021-06-06T00:00:00Z</dc:date>')))).toBe(
      '2021-06-06T00:00:00.000Z'
    );
  });

  it('returns null for core properties with no date and for an empty element', () => {
    expect(parseOoxmlCoreCreated(coreXml('<dc:creator>Someone</dc:creator>'))).toBeNull();
    expect(parseOoxmlCoreCreated(coreXml('<dcterms:created></dcterms:created>'))).toBeNull();
  });

  // The fallback keys on whether created PARSES, not on whether it matches: a producer writing a
  // locale date into created must not suppress a well-formed dc:date sitting beside it.
  it('falls back to dc:date when created is present but unparseable', () => {
    const xml = coreXml('<dcterms:created>03/04/2019</dcterms:created><dc:date>2021-06-06T00:00:00Z</dc:date>');
    expect(iso(parseOoxmlCoreCreated(xml))).toBe('2021-06-06T00:00:00.000Z');
  });

  it('returns null when neither element parses', () => {
    const xml = coreXml('<dcterms:created>03/04/2019</dcterms:created><dc:date>not a date</dc:date>');
    expect(parseOoxmlCoreCreated(xml)).toBeNull();
  });
});

// Date.UTC maps a two-digit year onto 1900-1999, so a garbage year would otherwise arrive as a
// perfectly plausible one and pass the window check downstream.
describe('two-digit year remapping is refused, not accepted as 19xx', () => {
  it('rejects a sub-100 year in a PDF info date', () => {
    expect(parsePdfInfoDate('D:00990304')).toBeNull();
    expect(parsePdfInfoDate('D:00010304')).toBeNull();
  });

  it('rejects a sub-100 year in an ISO prefix, via both parsers that use it', () => {
    expect(parseOoxmlCoreCreated('<dcterms:created>0099-03-04</dcterms:created>')).toBeNull();
    expect(parseFrontmatterDate('---\ndate: 0099-03-04\n---\n')).toBeNull();
  });

  it('still accepts a real four-digit year', () => {
    expect(iso(parsePdfInfoDate('D:20190304'))).toBe('2019-03-04T00:00:00.000Z');
    expect(iso(parseOoxmlCoreCreated('<dcterms:created>2019-03-04</dcterms:created>'))).toBe(
      '2019-03-04T00:00:00.000Z'
    );
  });
});

describe('parseFrontmatterDate', () => {
  it('reads a date from a leading frontmatter block', () => {
    expect(iso(parseFrontmatterDate('---\ntitle: Report\ndate: 2019-03-04\n---\n\nBody text'))).toBe(
      '2019-03-04T00:00:00.000Z'
    );
  });

  it('strips surrounding quotes and accepts a time part', () => {
    expect(iso(parseFrontmatterDate('---\ndate: "2019-03-04T09:15:00Z"\n---\n'))).toBe('2019-03-04T09:15:00.000Z');
    expect(iso(parseFrontmatterDate("---\ndate: '2019-03-04'\n---\n"))).toBe('2019-03-04T00:00:00.000Z');
  });

  it('honours key precedence rather than document order', () => {
    const text = '---\ncreated: 2018-01-01\npublished: 2020-02-02\ndate: 2019-03-04\n---\n';
    expect(iso(parseFrontmatterDate(text))).toBe('2019-03-04T00:00:00.000Z');
  });

  it.each(['pub_date', 'pub-date', 'pubDate', 'publish_date', 'publish-date', 'publishDate'])(
    'accepts the separator spelling %s',
    key => {
      expect(iso(parseFrontmatterDate(`---\n${key}: 2019-03-04\n---\n`))).toBe('2019-03-04T00:00:00.000Z');
    }
  );

  // The spellings are enumerated rather than derived by stripping `_` and `-`, because that strip
  // also folded each of these into a real key and read it as the document's vintage.
  it.each(['d_ate', '_date', 'd-a-t-e', 'pu_b_date'])('refuses the near-miss key %s', key => {
    expect(parseFrontmatterDate(`---\n${key}: 2019-03-04\n---\n`)).toBeNull();
  });

  it('ignores a date on a nested key, which describes something other than the document', () => {
    const text = '---\ntitle: Report\nauthor:\n  date: 2019-03-04\n---\n';
    expect(parseFrontmatterDate(text)).toBeNull();
  });

  it('ignores a date-shaped key outside the frontmatter block', () => {
    expect(parseFrontmatterDate('# Heading\n\ndate: 2019-03-04\n')).toBeNull();
  });

  it('returns null when there is no frontmatter, or no date key in it', () => {
    expect(parseFrontmatterDate('Just a plain document.')).toBeNull();
    expect(parseFrontmatterDate('---\ntitle: Report\n---\n')).toBeNull();
  });

  it('returns null for a non-date value rather than guessing', () => {
    expect(parseFrontmatterDate('---\ndate: sometime last spring\n---\n')).toBeNull();
    expect(parseFrontmatterDate('---\ndate: 2019\n---\n')).toBeNull();
  });

  it('does not scan past the leading-bytes limit', () => {
    const padded = `---\n${'filler: x\n'.repeat(2000)}date: 2019-03-04\n---\n`;
    expect(parseFrontmatterDate(padded)).toBeNull();
  });
});

// The three formats disagreed here: the PDF parser applied the info dictionary's UTC offset while
// the ISO parser ignored any zone designator, so one authored date printed a different day
// depending on which container it arrived in.
describe('one authored day renders identically whatever format carried it', () => {
  it.each([
    ['PDF info dictionary', () => parsePdfInfoDate("D:20190304093000+05'30'")],
    [
      'OOXML core properties',
      () => parseOoxmlCoreCreated('<dcterms:created>2019-03-04T09:30:00+05:30</dcterms:created>'),
    ],
    ['frontmatter', () => parseFrontmatterDate('---\ndate: 2019-03-04T09:30:00+05:30\n---\n')],
  ])('%s', (_label, parse) => {
    expect(renderedDay(parse())).toBe('2019-03-04');
  });
});

describe('acceptDocumentDate', () => {
  const now = Date.UTC(2026, 8, 23);

  it('pairs an in-window date with its source', () => {
    expect(acceptDocumentDate(new Date('2019-03-04T00:00:00Z'), DocumentDateSource.PDF_METADATA, now)).toEqual({
      date: new Date('2019-03-04T00:00:00Z'),
      source: DocumentDateSource.PDF_METADATA,
    });
  });

  it('drops a null candidate and one outside the window', () => {
    expect(acceptDocumentDate(null, DocumentDateSource.PDF_METADATA, now)).toBeUndefined();
    expect(acceptDocumentDate(new Date('1970-01-01T00:00:00Z'), DocumentDateSource.DRIVE_CREATED, now)).toBeUndefined();
  });

  // SheetJS's BIFF8 (.xls) reader returns Props.CreatedDate as an ISO string despite declaring it
  // as a Date. Before this, getTime() threw a TypeError and the whole chunk pass rejected.
  it('normalises an ISO string candidate instead of throwing on it', () => {
    expect(acceptDocumentDate('2019-03-04T00:00:00Z', DocumentDateSource.DOCUMENT_PROPERTIES, now)).toEqual({
      date: new Date('2019-03-04T00:00:00.000Z'),
      source: DocumentDateSource.DOCUMENT_PROPERTIES,
    });
    expect(acceptDocumentDate(undefined, DocumentDateSource.DOCUMENT_PROPERTIES, now)).toBeUndefined();
  });

  // Strings go through the anchored ISO parser, never `new Date(...)`: the constructor's non-ISO
  // fallback is implementation-defined and would let a guess become a stored vintage.
  it('refuses a string that is not an anchored ISO date', () => {
    for (const raw of ['Q3 budget', '12', '03/04/2019', '']) {
      expect(acceptDocumentDate(raw, DocumentDateSource.DOCUMENT_PROPERTIES, now)).toBeUndefined();
    }
  });

  it('still applies the plausibility window to a string candidate', () => {
    expect(acceptDocumentDate('1601-01-01T00:00:00Z', DocumentDateSource.DOCUMENT_PROPERTIES, now)).toBeUndefined();
  });
});

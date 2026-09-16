import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { SupportedFabFileMimeTypes, readZipEntryBounded, type BoundedZipEntry } from '@bike4mind/common';
import { isAiEditableOfficeMime, extractEditableText, applyEditedText } from './officeEdit';

const DOCX_MIME = SupportedFabFileMimeTypes.DOCX;
const XLSX_MIME = SupportedFabFileMimeTypes.XLSX;

// Minimal but valid-enough .docx: a zip whose word/document.xml holds two body paragraphs
// and a one-row table (table cells are also <w:p>), plus a trailing sectPr.
const DOCX_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
  `<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>` +
  `<w:tbl><w:tr>` +
  `<w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc>` +
  `<w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc>` +
  `</w:tr></w:tbl>` +
  `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>` +
  `</w:body></w:document>`;

async function makeDocx(documentXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file('word/document.xml', documentXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function documentXmlOf(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return zip.file('word/document.xml')!.async('string');
}

function makeXlsx(): Buffer {
  // A2:B2 are literal values; C2 is a formula referencing B2. Round-trip must keep C2 a formula.
  const ws = XLSX.utils.aoa_to_sheet([
    ['Item', 'Price', 'Tax'],
    ['Widget', 10, null],
  ]);
  ws['C2'] = { t: 'n', f: 'B2*0.1' };
  ws['!ref'] = 'A1:C2';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('isAiEditableOfficeMime', () => {
  it('accepts docx and xlsx, rejects everything else', () => {
    expect(isAiEditableOfficeMime(DOCX_MIME)).toBe(true);
    expect(isAiEditableOfficeMime(XLSX_MIME)).toBe(true);
    expect(isAiEditableOfficeMime(SupportedFabFileMimeTypes.XLS)).toBe(false);
    expect(isAiEditableOfficeMime('text/markdown')).toBe(false);
    expect(isAiEditableOfficeMime(undefined)).toBe(false);
  });
});

describe('docx round-trip', () => {
  it('extracts numbered paragraphs including table cells', async () => {
    const buffer = await makeDocx(DOCX_XML);
    const text = await extractEditableText(buffer, DOCX_MIME);
    expect(text).toBe('[1] Hello World\n[2] Second paragraph\n[3] Cell A\n[4] Cell B');
  });

  it('applies an edit to one paragraph and preserves structure, table, and untouched text', async () => {
    const buffer = await makeDocx(DOCX_XML);
    const edited = '[1] Goodbye World\n[2] Second paragraph\n[3] Cell A\n[4] Cell B';
    const out = await applyEditedText(buffer, edited, DOCX_MIME);

    const reExtracted = await extractEditableText(out, DOCX_MIME);
    expect(reExtracted).toBe('[1] Goodbye World\n[2] Second paragraph\n[3] Cell A\n[4] Cell B');

    const xml = await documentXmlOf(out);
    expect(xml).toContain('<w:tbl>'); // table structure survives
    expect(xml).toContain('<w:sectPr>'); // section properties survive
  });

  it('escapes XML-special characters in edited text', async () => {
    const buffer = await makeDocx(DOCX_XML);
    const out = await applyEditedText(buffer, '[1] a < b & c > d', DOCX_MIME);
    const xml = await documentXmlOf(out);
    expect(xml).toContain('a &lt; b &amp; c &gt; d');
    // Re-extract decodes back to the original characters.
    const reExtracted = await extractEditableText(out, DOCX_MIME);
    expect(reExtracted.split('\n')[0]).toBe('[1] a < b & c > d');
  });

  it('appends a new paragraph before the sectPr when the edit adds an index', async () => {
    const buffer = await makeDocx(DOCX_XML);
    const edited = '[1] Hello World\n[2] Second paragraph\n[3] Cell A\n[4] Cell B\n[5] Appended line';
    const out = await applyEditedText(buffer, edited, DOCX_MIME);
    const reExtracted = await extractEditableText(out, DOCX_MIME);
    expect(reExtracted.split('\n')).toHaveLength(5);
    expect(reExtracted.split('\n')[4]).toBe('[5] Appended line');
    const xml = await documentXmlOf(out);
    // Must land at BODY level: AFTER the closing table tag (not spliced inside the last table
    // cell) and BEFORE the section properties (which must remain the final body child).
    expect(xml.indexOf('Appended line')).toBeGreaterThan(xml.lastIndexOf('</w:tbl>'));
    expect(xml.indexOf('Appended line')).toBeLessThan(xml.indexOf('<w:sectPr>'));
  });

  it('is a no-op when the edited text has no paragraph markers', async () => {
    const buffer = await makeDocx(DOCX_XML);
    const out = await applyEditedText(buffer, 'just some prose without markers', DOCX_MIME);
    expect(await extractEditableText(out, DOCX_MIME)).toBe(await extractEditableText(buffer, DOCX_MIME));
  });
});

describe('xlsx round-trip', () => {
  it('extracts each sheet as a CSV block showing formulas with a leading =', async () => {
    const text = await extractEditableText(makeXlsx(), XLSX_MIME);
    expect(text).toContain('### Sheet: Sheet1');
    expect(text).toContain('Item,Price,Tax');
    expect(text).toContain('Widget,10,=B2*0.1');
  });

  it('edits a value cell while preserving the formula cell', async () => {
    const buffer = makeXlsx();
    const edited = '### Sheet: Sheet1\nItem,Price,Tax\nWidget,20,=B2*0.1';
    const out = await applyEditedText(buffer, edited, XLSX_MIME);

    const wb = XLSX.read(out, { type: 'buffer', cellFormula: true });
    const sheet = wb.Sheets['Sheet1'];
    expect(sheet['B2'].v).toBe(20); // value changed
    expect(sheet['C2'].f).toBe('B2*0.1'); // formula preserved, not clobbered with computed value
    expect(sheet['A2'].v).toBe('Widget'); // untouched cell intact
  });

  it('updates a formula when the edit changes it', async () => {
    const buffer = makeXlsx();
    const edited = '### Sheet: Sheet1\nItem,Price,Tax\nWidget,10,=B2*0.2';
    const out = await applyEditedText(buffer, edited, XLSX_MIME);
    const wb = XLSX.read(out, { type: 'buffer', cellFormula: true });
    expect(wb.Sheets['Sheet1']['C2'].f).toBe('B2*0.2');
  });

  it('preserves formulas when the edit introduces a brand-new sheet', async () => {
    const buffer = makeXlsx();
    const edited =
      '### Sheet: Sheet1\nItem,Price,Tax\nWidget,10,=B2*0.1\n\n### Sheet: Totals\nGrand Total,=SUM(Sheet1!B2:B2)';
    const out = await applyEditedText(buffer, edited, XLSX_MIME);
    const wb = XLSX.read(out, { type: 'buffer', cellFormula: true });
    expect(wb.SheetNames).toContain('Totals');
    // The formula in the new sheet must survive (not be flattened to an empty/blank cell).
    expect(wb.Sheets['Totals']['B1'].f).toBe('SUM(Sheet1!B2:B2)');
  });

  it('handles quoted cells containing commas', async () => {
    const buffer = makeXlsx();
    const edited = '### Sheet: Sheet1\nItem,Price,Tax\n"Widget, deluxe",10,=B2*0.1';
    const out = await applyEditedText(buffer, edited, XLSX_MIME);
    const wb = XLSX.read(out, { type: 'buffer', cellFormula: true });
    expect(wb.Sheets['Sheet1']['A2'].v).toBe('Widget, deluxe');
  });
});

describe('unsupported mime', () => {
  it('throws on extract and apply for a non-office mime', async () => {
    await expect(extractEditableText(Buffer.from('x'), 'text/plain')).rejects.toThrow();
    await expect(applyEditedText(Buffer.from('x'), 'y', 'text/plain')).rejects.toThrow();
  });
});

describe('xlsx sheet-name prototype-pollution guard', () => {
  it('rejects a reserved sheet name', async () => {
    // `book_append_sheet(wb, ws, '__proto__')` reassigns `wb.Sheets`'s OWN prototype to the sheet
    // object - it never writes shared `Object.prototype` - so the rejection itself is the whole
    // assertion here. The own-property read is what the sibling test below covers.
    const buffer = makeXlsx();
    const edited = '### Sheet: __proto__\nA,polluted\nx,y';
    await expect(applyEditedText(buffer, edited, XLSX_MIME)).rejects.toThrow(/sheet name/i);
  });

  it('looks up an existing sheet by own property, not through the prototype chain', async () => {
    // A sheet legitimately named `A1` must not read as "already existing" just because
    // Object.prototype happens to carry an A1 key.
    // Non-enumerable so it stays out of the `for...in` loops inside xlsx: the point is only
    // that a prototype-chain read finds it, not that it contaminates iteration.
    Object.defineProperty(Object.prototype, 'A1', {
      value: { t: 's', v: 'from-prototype' },
      configurable: true,
      writable: true,
    });

    const buffer = makeXlsx();
    const out = await applyEditedText(buffer, '### Sheet: A1\nfresh', XLSX_MIME);
    const wb = XLSX.read(out, { type: 'buffer', cellFormula: true });

    expect(wb.SheetNames).toContain('A1');
    expect(wb.Sheets['A1']['A1'].v).toBe('fresh');
  });
});

describe('size-bound guards', () => {
  // Build a valid .xlsx, then patch its worksheet dimension to a crafted range so XLSX.read
  // reports an oversized !ref without XLSX.write ever materializing the grid (which itself
  // hangs on a huge range - the reason applyXlsxText's existingRef is bounded too).
  async function makeXlsxWithRefs(refs: string[]): Promise<Buffer> {
    const wb = XLSX.utils.book_new();
    refs.forEach((_, i) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['A1']]), `Sheet${i + 1}`));
    const small = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const zip = await JSZip.loadAsync(small);
    for (let i = 0; i < refs.length; i++) {
      const sheetPath = Object.keys(zip.files).find(p => p.endsWith(`xl/worksheets/sheet${i + 1}.xml`))!;
      const xml = (await zip.files[sheetPath].async('string')).replace(
        /<dimension ref="[^"]*"\/>/,
        `<dimension ref="${refs[i]}"/>`
      );
      zip.file(sheetPath, xml);
    }
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  const makeXlsxWithRef = (ref: string): Promise<Buffer> => makeXlsxWithRefs([ref]);

  it('rejects an xlsx whose !ref declares more cells than the cap, without iterating it', async () => {
    const buffer = await makeXlsxWithRef('A1:XFD1048576'); // the full grid, ~17e9 cells
    const start = Date.now();
    await expect(extractEditableText(buffer, XLSX_MIME)).rejects.toThrow(/cells/);
    expect(Date.now() - start).toBeLessThan(1000); // bounded before the loop, not after
  });

  it('rejects the same oversized !ref on the apply (write-back) path', async () => {
    const buffer = await makeXlsxWithRef('A1:XFD1048576');
    await expect(applyEditedText(buffer, '### Sheet: Sheet1\nx', XLSX_MIME)).rejects.toThrow(/cells/);
  });

  it('still extracts a normally-sized sheet', async () => {
    const buffer = await makeXlsxWithRef('A1:A1');
    await expect(extractEditableText(buffer, XLSX_MIME)).resolves.toContain('### Sheet: Sheet1');
  });

  it('rejects a docx whose document.xml decompresses over the per-entry cap', async () => {
    const bomb =
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${'a'.repeat(33 * 1024 * 1024)}</w:t></w:r></w:p></w:body></w:document>`;
    const docx = await makeDocx(bomb);
    await expect(extractEditableText(docx, DOCX_MIME)).rejects.toThrow(/decompressed/);
  });

  it('bounds a zip entry that under-declares its uncompressed size', async () => {
    // The declared size comes from the zip's own headers, so the file's author sets it, and jszip
    // only compares it against reality AFTER inflating the entry in full. Lie about it here: the
    // read must still stop, because the bound is on the inflate rather than on the header.
    const zip = await JSZip.loadAsync(await makeDocx(`<w:t>${'a'.repeat(4 * 1024 * 1024)}</w:t>`));
    const entry = zip.files['word/document.xml'];
    (entry as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize = 100;

    const result = await readZipEntryBounded(entry as unknown as BoundedZipEntry, 64 * 1024);
    expect(result.ok).toBe(false);
  });

  it('counts an entry in bytes, not UTF-16 code units', async () => {
    // `entry.async('string')` decodes UTF-8 first, so measuring the decoded string ran up to ~3x
    // lenient on multi-byte content. 600 x U+00E9 is 600 code units but 1200 bytes.
    const zip = new JSZip();
    zip.file('multibyte.xml', '\u00e9'.repeat(600));
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }));

    const result = await readZipEntryBounded(loaded.files['multibyte.xml'] as unknown as BoundedZipEntry, 1000);
    expect(result.ok).toBe(false);
  });

  it('reads an entry that stays within the cap, decoding multi-byte content correctly', async () => {
    const zip = new JSZip();
    zip.file('ok.xml', `<w:t>${'\u00e9'.repeat(10)}</w:t>`);
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }));

    const result = await readZipEntryBounded(loaded.files['ok.xml'] as unknown as BoundedZipEntry, 1000);
    // 11 ASCII tag bytes + 10 two-byte characters. The same content is 21 UTF-16 code units, which
    // is what the old post-read `text.length` check measured.
    expect(result).toEqual({ ok: true, text: `<w:t>${'\u00e9'.repeat(10)}</w:t>`, byteLength: 31 });
  });

  it('rejects a workbook whose sheets exceed the cell cap in aggregate, not just per sheet', async () => {
    // A worksheet declaring a large range and populating nothing is a couple of hundred bytes, so
    // the attacker multiplies sheets rather than enlarging one. Neither sheet trips the cap alone.
    const buffer = await makeXlsxWithRefs(['A1:B1', 'A1:A999999']);
    const start = Date.now();
    await expect(extractEditableText(buffer, XLSX_MIME)).rejects.toThrow(/cells/);
    expect(Date.now() - start).toBeLessThan(1000); // rejected before the second sheet is iterated
  });
});

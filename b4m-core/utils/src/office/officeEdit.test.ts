import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { SupportedFabFileMimeTypes } from '@bike4mind/common';
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
    // sectPr must remain the last body element even after the append.
    const xml = await documentXmlOf(out);
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

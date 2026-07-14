import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import { BadRequestError } from '../errors';

/**
 * Round-trip AI editing for Office documents (.docx, .xlsx). The AI edit flow works on a
 * flat text representation: `extractEditableText` turns the binary into editable text, the
 * LLM rewrites that text, and `applyEditedText` merges the rewrite back into the ORIGINAL
 * binary so structure/formatting the edit did not touch is preserved.
 *
 * - docx: text-run surgery on `word/document.xml` (same OOXML approach as chunkPPTX in
 *   fab-pipeline). Only the text inside `<w:t>` runs changes; tables, styles, headers, and
 *   every other element stay byte-for-byte. An edited paragraph's mixed inline formatting
 *   collapses onto its first run (documented limitation).
 * - xlsx: SheetJS reads the workbook, and only cells whose text representation actually
 *   changed are written back into the loaded worksheet objects, so untouched formulas,
 *   number formats, and structure survive.
 *
 * .xls (legacy BIFF) is intentionally NOT editable here: SheetJS write fidelity for BIFF is
 * weak and the ticket targets .docx/.xlsx only.
 */

/** Per-paragraph marker used in the docx text representation, e.g. `[1] Heading text`. */
const DOCX_PARA_MARKER_RE = /^\s*\[(\d+)\]\s?([\s\S]*)$/;
/** Sheet delimiter used in the xlsx text representation. */
const XLSX_SHEET_HEADER = '### Sheet: ';

export function isAiEditableOfficeMime(mime?: string | null): boolean {
  return mime === SupportedFabFileMimeTypes.DOCX || mime === SupportedFabFileMimeTypes.XLSX;
}

/**
 * Hard server-side cap on the raw Office binary an edit route will read into memory. The
 * editable-text representation has its own (smaller) size gate, but that only applies AFTER
 * the full binary is parsed - this bounds the pre-parse buffer so a direct API caller can't
 * force an unbounded read (the client UI also gates, but that is bypassable). 10 MB.
 */
export const MAX_OFFICE_EDIT_BYTES = 10 * 1024 * 1024;

export async function extractEditableText(buffer: Buffer, mime: string): Promise<string> {
  if (mime === SupportedFabFileMimeTypes.DOCX) return extractDocxText(buffer);
  if (mime === SupportedFabFileMimeTypes.XLSX) return extractXlsxText(buffer);
  throw new BadRequestError(`Office AI-editing is not supported for mime type: ${mime}`);
}

export async function applyEditedText(originalBuffer: Buffer, editedText: string, mime: string): Promise<Buffer> {
  if (mime === SupportedFabFileMimeTypes.DOCX) return applyDocxText(originalBuffer, editedText);
  if (mime === SupportedFabFileMimeTypes.XLSX) return applyXlsxText(originalBuffer, editedText);
  throw new BadRequestError(`Office AI-editing is not supported for mime type: ${mime}`);
}

// ---------------------------------------------------------------------------
// XML helpers (shared by the docx path)
// ---------------------------------------------------------------------------

const xmlUnescape = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A paragraph is either self-closing (`<w:p/>`) or a normal `<w:p>...</w:p>`. Paragraphs do
// not nest, so a non-greedy body up to the first `</w:p>` is safe. Table-cell paragraphs are
// matched too (they are `<w:p>` nested inside `<w:tc>`), so table text is editable in order.
const DOCX_PARA_RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
// Text run: `<w:t/>`, or `<w:t ...>text</w:t>` (attrs like xml:space are common).
const DOCX_T_RE = /<w:t\b[^>]*\/>|<w:t\b[^>]*>[\s\S]*?<\/w:t>/g;

const paragraphText = (paraXml: string): string => {
  const runs = paraXml.match(DOCX_T_RE) ?? [];
  return runs.map(r => xmlUnescape(r.replace(/<w:t\b[^>]*\/>|<w:t\b[^>]*>|<\/w:t>/g, ''))).join('');
};

/**
 * Replace a paragraph's text: write `text` into its FIRST `<w:t>` run and blank the rest so
 * paragraph-level formatting is kept while intra-paragraph run splits collapse. If the
 * paragraph has no run yet, inject one (expanding a self-closing `<w:p/>` when needed).
 */
const setParagraphText = (paraXml: string, text: string): string => {
  const escaped = xmlEscape(text);
  if (DOCX_T_RE.test(paraXml)) {
    DOCX_T_RE.lastIndex = 0; // reset: .test() advances lastIndex on a /g regex
    let first = true;
    return paraXml.replace(DOCX_T_RE, () => {
      if (first) {
        first = false;
        return `<w:t xml:space="preserve">${escaped}</w:t>`;
      }
      return '<w:t xml:space="preserve"></w:t>';
    });
  }
  DOCX_T_RE.lastIndex = 0;
  if (!text) return paraXml; // nothing to inject
  const run = `<w:r><w:t xml:space="preserve">${escaped}</w:t></w:r>`;
  const selfClosing = paraXml.match(/^<w:p\b([^>]*)\/>$/);
  if (selfClosing) return `<w:p${selfClosing[1]}>${run}</w:p>`;
  return paraXml.replace(/<\/w:p>$/, `${run}</w:p>`);
};

// ---------------------------------------------------------------------------
// docx
// ---------------------------------------------------------------------------

async function loadDocumentXml(buffer: Buffer): Promise<{ zip: import('jszip'); xml: string }> {
  const JSZip = (await import('jszip')).default;
  let zip: import('jszip');
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new BadRequestError('File is not a valid .docx document');
  }
  const entry = zip.file('word/document.xml');
  if (!entry) throw new BadRequestError('File is not a valid .docx document (missing word/document.xml)');
  const xml = await entry.async('string');
  return { zip, xml };
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const { xml } = await loadDocumentXml(buffer);
  const paras = xml.match(DOCX_PARA_RE) ?? [];
  return paras.map((p, i) => `[${i + 1}] ${paragraphText(p)}`).join('\n');
}

/** Parse the docx text representation into a 1-based paragraph-index -> new-text map. */
const parseDocxMarkers = (editedText: string): Map<number, string> => {
  const map = new Map<number, string>();
  for (const line of editedText.split(/\r?\n/)) {
    const m = line.match(DOCX_PARA_MARKER_RE);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
};

async function applyDocxText(originalBuffer: Buffer, editedText: string): Promise<Buffer> {
  const { zip, xml } = await loadDocumentXml(originalBuffer);
  const edits = parseDocxMarkers(editedText);
  // Markers are the only supported mapping; if none survived, do nothing rather than risk
  // corrupting the document by guessing positional alignment.
  if (edits.size === 0) return originalBuffer;

  const paras = xml.match(DOCX_PARA_RE) ?? [];
  const originalCount = paras.length;

  let idx = 0;
  let newXml = xml.replace(DOCX_PARA_RE, para => {
    idx++;
    return edits.has(idx) ? setParagraphText(para, edits.get(idx) ?? '') : para;
  });

  // Appended paragraphs (indices beyond the original count). Build minimal fresh body
  // paragraphs (a cloned template could carry table-cell properties that are invalid at body
  // level). Insert them at BODY level: immediately before the final `<w:sectPr>` (the
  // document's section properties, which must remain the last child of `<w:body>`), else before
  // `</w:body>`. NOT after the last `</w:p>` - that closer may belong to a table-cell paragraph
  // when the document ends with a table, which would splice the new content inside the cell.
  const appendedIndices = [...edits.keys()].filter(i => i > originalCount).sort((a, b) => a - b);
  if (appendedIndices.length > 0) {
    const freshParagraph = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
    const appended = appendedIndices.map(i => freshParagraph(edits.get(i) ?? '')).join('');
    const sectPrIdx = newXml.lastIndexOf('<w:sectPr');
    if (sectPrIdx !== -1) {
      newXml = newXml.slice(0, sectPrIdx) + appended + newXml.slice(sectPrIdx);
    } else {
      newXml = newXml.replace(/<\/w:body>/, `${appended}</w:body>`);
    }
  }

  zip.file('word/document.xml', newXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

const csvEscape = (s: string): string => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Text shown for a cell: a leading-`=` formula, or its formatted/raw value, or empty. */
const cellToText = (cell: import('xlsx').CellObject | undefined): string => {
  if (!cell) return '';
  if (cell.f) return `=${cell.f}`;
  if (cell.w !== undefined) return cell.w;
  if (cell.v === undefined || cell.v === null) return '';
  return String(cell.v);
};

async function extractXlsxText(buffer: Buffer): Promise<string> {
  const XLSX = await import('xlsx');
  let workbook: import('xlsx').WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellStyles: true });
  } catch {
    throw new BadRequestError('File is not a valid .xlsx spreadsheet');
  }

  const blocks: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const lines = [`${XLSX_SHEET_HEADER}${sheetName}`];
    const ref = sheet['!ref'];
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      for (let r = range.s.r; r <= range.e.r; r++) {
        const row: string[] = [];
        for (let c = range.s.c; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r, c });
          row.push(csvEscape(cellToText(sheet[addr])));
        }
        lines.push(row.join(','));
      }
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/** Split the xlsx text representation into { sheetName -> raw CSV block } in document order. */
const splitXlsxSheets = (editedText: string): { name: string; csv: string }[] => {
  const sheets: { name: string; csv: string }[] = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const line of editedText.split(/\r?\n/)) {
    if (line.startsWith(XLSX_SHEET_HEADER)) {
      if (current) sheets.push({ name: current.name, csv: current.lines.join('\n') });
      current = { name: line.slice(XLSX_SHEET_HEADER.length).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sheets.push({ name: current.name, csv: current.lines.join('\n') });
  return sheets;
};

/** Build a SheetJS cell object for a changed text value (formula, number, or string). */
const cellFromText = (text: string): import('xlsx').CellObject | null => {
  if (text.startsWith('=')) return { t: 'n', f: text.slice(1) };
  if (text === '') return null; // cleared
  const num = Number(text);
  if (text.trim() !== '' && !Number.isNaN(num)) return { t: 'n', v: num };
  return { t: 's', v: text };
};

async function applyXlsxText(originalBuffer: Buffer, editedText: string): Promise<Buffer> {
  const XLSX = await import('xlsx');
  const { parse } = await import('csv-parse/sync');

  let workbook: import('xlsx').WorkBook;
  try {
    workbook = XLSX.read(originalBuffer, { type: 'buffer', cellFormula: true, cellStyles: true });
  } catch {
    throw new BadRequestError('File is not a valid .xlsx spreadsheet');
  }

  for (const { name, csv } of splitXlsxSheets(editedText)) {
    const rows = parse(csv.replace(/\s+$/, ''), { relax_column_count: true, skip_empty_lines: false }) as string[][];

    let sheet = workbook.Sheets[name];
    if (!sheet) {
      // New sheet introduced by the edit: build it wholesale from the grid.
      sheet = XLSX.utils.aoa_to_sheet(rows.map(row => row.map(cell => cellFromText(cell)?.v ?? '')));
      XLSX.utils.book_append_sheet(workbook, sheet, name);
      continue;
    }

    const existingRef = sheet['!ref']
      ? XLSX.utils.decode_range(sheet['!ref'])
      : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    let maxR = existingRef.e.r;
    let maxC = existingRef.e.c;

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let c = 0; c < row.length; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const original = sheet[addr] as import('xlsx').CellObject | undefined;
        const newText = row[c];
        // Only write cells that actually changed; this keeps untouched formula cells (shown
        // as `=...`) intact rather than clobbering them with their computed value.
        if (newText === cellToText(original)) continue;
        const newCell = cellFromText(newText);
        if (newCell === null) {
          delete sheet[addr];
        } else {
          sheet[addr] = newCell;
          maxR = Math.max(maxR, r);
          maxC = Math.max(maxC, c);
        }
      }
    }

    sheet['!ref'] = XLSX.utils.encode_range({ s: existingRef.s, e: { r: maxR, c: maxC } });
  }

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

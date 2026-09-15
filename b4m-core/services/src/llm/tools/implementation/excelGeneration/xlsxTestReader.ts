/**
 * Minimal, library-agnostic OOXML (.xlsx) reader used only by the excel_generation
 * characterization tests. It unzips a generated workbook Buffer and parses the raw
 * SpreadsheetML so tests can assert on the *logical* content of the file (cell values,
 * formulas, resolved styles, merges, frozen panes) rather than on byte-equality or on
 * any writer library's internal object model.
 *
 * Why hand-rolled: the whole point of issue #110 is to migrate the writer from `exceljs`
 * to `write-excel-file` and PROVE parity. If the tests read back with the same library
 * that wrote the file, they would validate the library, not the file. Parsing the OOXML
 * XML directly means the exact same assertions must hold for both writers' output.
 *
 * Scope: it only understands the constructs the excel_generation tool emits. It is not a
 * general xlsx parser. It uses `yauzl` (already a services dependency) to unzip.
 */
import yauzl from 'yauzl';

export interface ResolvedStyle {
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  /** ARGB hex as stored in the file, e.g. "FFFF0000". */
  fontColor?: string;
  /** ARGB hex of the solid fill foreground, e.g. "FFFFFF00". */
  backgroundColor?: string;
  horizontalAlignment?: string;
  verticalAlignment?: string;
  numberFormat?: string;
  border?: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean };
}

export interface ParsedCell {
  address: string;
  row: number;
  col: number;
  value: string | number | boolean | null;
  formula?: string;
  style?: ResolvedStyle;
}

export interface ParsedSheet {
  name: string;
  /** All populated cells, keyed by A1-style address. */
  cells: Map<string, ParsedCell>;
  cell(address: string): ParsedCell | undefined;
  /** Merge ranges as A1-style refs, e.g. "A1:B2". */
  merges: string[];
  /** Column width by 1-indexed column number. */
  columnWidths: Map<number, number>;
  /** Row height by 1-indexed row number. */
  rowHeights: Map<number, number>;
  /** Frozen-pane split, in cells frozen (0 = none). Absent when no pane is set. */
  frozen?: { xSplit: number; ySplit: number };
}

export interface ParsedWorkbook {
  sheets: ParsedSheet[];
  sheet(name: string): ParsedSheet | undefined;
  creator?: string;
}

function unzipToMap(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'));
      const files = new Map<string, Buffer>();
      zip.readEntry();
      zip.on('entry', entry => {
        // Directory entries end with '/'.
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) return reject(streamErr ?? new Error('failed to read entry'));
          const chunks: Buffer[] = [];
          readStream.on('data', (chunk: Buffer) => chunks.push(chunk));
          readStream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
          readStream.on('error', reject);
        });
      });
      zip.on('end', () => resolve(files));
      zip.on('error', reject);
    });
  });
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, m => XML_ENTITIES[m]);
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : undefined;
}

function colLettersToNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

function parseAddress(address: string): { row: number; col: number } {
  const m = address.match(/^([A-Z]+)(\d+)$/);
  if (!m) return { row: 0, col: 0 };
  return { col: colLettersToNumber(m[1]), row: parseInt(m[2], 10) };
}

/** Concatenate the text of every <t> element inside an XML fragment. */
function extractText(fragment: string): string {
  const parts = [...fragment.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1]));
  return parts.join('');
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => extractText(m[1]));
}

/**
 * Standard OOXML builtin number-format codes (ISO 29500). Writers may either store a custom
 * <numFmt> with an explicit formatCode (id >= 164) OR reference a builtin id with no formatCode
 * stored in the file. exceljs maps common codes (e.g. "#,##0.00") to their builtin id, so this
 * table is needed to resolve them back to the same code write-excel-file would emit as custom.
 */
const BUILTIN_NUMFMTS: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'mm-dd-yy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
};

interface StyleTables {
  numFmts: Map<number, string>;
  fonts: Array<{ bold: boolean; italic: boolean; size?: number; color?: string }>;
  fills: Array<{ fgColor?: string; pattern?: string }>;
  borders: Array<{ top: boolean; bottom: boolean; left: boolean; right: boolean }>;
  cellXfs: Array<{
    numFmtId: number;
    fontId: number;
    fillId: number;
    borderId: number;
    horizontal?: string;
    vertical?: string;
  }>;
}

function sectionOf(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1] : '';
}

function parseStyles(xml: string | undefined): StyleTables {
  const tables: StyleTables = {
    numFmts: new Map(),
    fonts: [],
    fills: [],
    borders: [],
    cellXfs: [],
  };
  if (!xml) return tables;

  for (const m of xml.matchAll(/<numFmt\b[^>]*\/>/g)) {
    const id = attr(m[0], 'numFmtId');
    const code = attr(m[0], 'formatCode');
    if (id !== undefined && code !== undefined) tables.numFmts.set(parseInt(id, 10), code);
  }

  const fontsSection = sectionOf(xml, 'fonts');
  for (const m of fontsSection.matchAll(/<font>([\s\S]*?)<\/font>/g)) {
    const body = m[1];
    const sizeAttr = body.match(/<sz\b[^>]*\/>/)?.[0];
    const colorAttr = body.match(/<color\b[^>]*\/>/)?.[0];
    tables.fonts.push({
      bold: /<b\s*\/>/.test(body) || /<b\b[^>]*\/>/.test(body),
      italic: /<i\s*\/>/.test(body) || /<i\b[^>]*\/>/.test(body),
      size: sizeAttr ? Number(attr(sizeAttr, 'val')) : undefined,
      color: colorAttr ? attr(colorAttr, 'rgb') : undefined,
    });
  }

  const fillsSection = sectionOf(xml, 'fills');
  for (const m of fillsSection.matchAll(/<fill>([\s\S]*?)<\/fill>/g)) {
    const body = m[1];
    const patternTag = body.match(/<patternFill\b[^>]*>/)?.[0] ?? body.match(/<patternFill\b[^>]*\/>/)?.[0];
    const fgTag = body.match(/<fgColor\b[^>]*\/>/)?.[0];
    tables.fills.push({
      pattern: patternTag ? attr(patternTag, 'patternType') : undefined,
      fgColor: fgTag ? attr(fgTag, 'rgb') : undefined,
    });
  }

  const bordersSection = sectionOf(xml, 'borders');
  for (const m of bordersSection.matchAll(/<border\b[^>]*>([\s\S]*?)<\/border>/g)) {
    const body = m[1];
    const sideHasStyle = (side: string): boolean => {
      const tag = body.match(new RegExp(`<${side}\\b[^>]*?(/?)>`))?.[0] ?? '';
      return /style="/.test(tag);
    };
    tables.borders.push({
      top: sideHasStyle('top'),
      bottom: sideHasStyle('bottom'),
      left: sideHasStyle('left'),
      right: sideHasStyle('right'),
    });
  }

  const cellXfsSection = sectionOf(xml, 'cellXfs');
  // Each <xf> is either self-closing (<xf .../>) or wraps an <alignment> (<xf ...>...</xf>).
  // The two forms are matched as separate alternatives; a single [^>]* alternation would
  // swallow the self-closing "/" and run past into the next element.
  for (const m of cellXfsSection.matchAll(/<xf\b[^>]*?\/>|<xf\b[^>]*?>[\s\S]*?<\/xf>/g)) {
    const xf = m[0];
    const alignTag = xf.match(/<alignment\b[^>]*\/>/)?.[0];
    tables.cellXfs.push({
      numFmtId: Number(attr(xf, 'numFmtId') ?? '0'),
      fontId: Number(attr(xf, 'fontId') ?? '0'),
      fillId: Number(attr(xf, 'fillId') ?? '0'),
      borderId: Number(attr(xf, 'borderId') ?? '0'),
      horizontal: alignTag ? attr(alignTag, 'horizontal') : undefined,
      vertical: alignTag ? attr(alignTag, 'vertical') : undefined,
    });
  }

  return tables;
}

function resolveStyle(styleIndex: number, styles: StyleTables): ResolvedStyle | undefined {
  const xf = styles.cellXfs[styleIndex];
  if (!xf) return undefined;
  const resolved: ResolvedStyle = {};

  const font = styles.fonts[xf.fontId];
  if (font) {
    if (font.bold) resolved.bold = true;
    if (font.italic) resolved.italic = true;
    if (font.size !== undefined) resolved.fontSize = font.size;
    if (font.color) resolved.fontColor = font.color;
  }

  const fill = styles.fills[xf.fillId];
  if (fill?.pattern === 'solid' && fill.fgColor) {
    resolved.backgroundColor = fill.fgColor;
  }

  if (xf.horizontal) resolved.horizontalAlignment = xf.horizontal;
  if (xf.vertical) resolved.verticalAlignment = xf.vertical;

  const numFmt = styles.numFmts.get(xf.numFmtId) ?? BUILTIN_NUMFMTS[xf.numFmtId];
  // numFmtId 0 is "General" (no format) - don't surface it as an explicit numberFormat.
  if (numFmt && xf.numFmtId !== 0) resolved.numberFormat = numFmt;

  const border = styles.borders[xf.borderId];
  if (border && (border.top || border.bottom || border.left || border.right)) {
    resolved.border = {};
    if (border.top) resolved.border.top = true;
    if (border.bottom) resolved.border.bottom = true;
    if (border.left) resolved.border.left = true;
    if (border.right) resolved.border.right = true;
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function decodeCellValue(
  cellTag: string,
  body: string,
  sharedStrings: string[]
): { value: string | number | boolean | null; formula?: string } {
  const type = attr(cellTag, 't');
  const formulaMatch = body.match(/<f[^>]*>([\s\S]*?)<\/f>/);
  // Report the raw OOXML <f> content verbatim (no normalization). A correct formula cell holds
  // the expression WITHOUT a leading "=" (Excel prepends it); a leading "=" here is the "=="
  // writer bug, so assertions must be able to see it rather than have it silently stripped.
  const formula = formulaMatch ? decodeXml(formulaMatch[1]) : undefined;

  const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
  const rawV = vMatch ? decodeXml(vMatch[1]) : undefined;

  let value: string | number | boolean | null = null;
  if (type === 's') {
    value = rawV !== undefined ? (sharedStrings[Number(rawV)] ?? null) : null;
  } else if (type === 'inlineStr') {
    value = extractText(body);
  } else if (type === 'str') {
    value = rawV ?? null;
  } else if (type === 'b') {
    value = rawV === '1';
  } else if (rawV !== undefined && rawV !== '') {
    value = Number(rawV);
  }

  return { value, formula };
}

function parseSheet(name: string, xml: string, sharedStrings: string[], styles: StyleTables): ParsedSheet {
  const cells = new Map<string, ParsedCell>();

  const sheetData = xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/)?.[1] ?? '';
  for (const cellMatch of sheetData.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const cellTag = `<c${cellMatch[1]}>`;
    const body = cellMatch[2] ?? '';
    const address = attr(cellTag, 'r');
    if (!address) continue;
    const { row, col } = parseAddress(address);
    const { value, formula } = decodeCellValue(cellTag, body, sharedStrings);
    const styleAttr = attr(cellTag, 's');
    const style = styleAttr !== undefined ? resolveStyle(Number(styleAttr), styles) : undefined;
    // Skip cells that carry neither a value, a formula, nor a style (nothing to assert on).
    if (value === null && !formula && !style) continue;
    cells.set(address, { address, row, col, value, formula, style });
  }

  const merges = [...xml.matchAll(/<mergeCell\b[^>]*ref="([^"]+)"[^>]*\/>/g)].map(m => m[1]);

  const columnWidths = new Map<number, number>();
  for (const m of xml.matchAll(/<col\b[^>]*\/>/g)) {
    const min = attr(m[0], 'min');
    const max = attr(m[0], 'max');
    const width = attr(m[0], 'width');
    if (min && width) {
      const from = parseInt(min, 10);
      const to = max ? parseInt(max, 10) : from;
      for (let c = from; c <= to; c++) columnWidths.set(c, Number(width));
    }
  }

  const rowHeights = new Map<number, number>();
  for (const m of sheetData.matchAll(/<row\b([^>]*)>/g)) {
    const rowTag = `<row${m[1]}>`;
    const r = attr(rowTag, 'r');
    const ht = attr(rowTag, 'ht');
    if (r && ht) rowHeights.set(parseInt(r, 10), Number(ht));
  }

  let frozen: { xSplit: number; ySplit: number } | undefined;
  const paneTag = xml.match(/<pane\b[^>]*\/>/)?.[0];
  if (paneTag && /state="frozen"/.test(paneTag)) {
    frozen = {
      xSplit: Number(attr(paneTag, 'xSplit') ?? '0'),
      ySplit: Number(attr(paneTag, 'ySplit') ?? '0'),
    };
  }

  return {
    name,
    cells,
    cell: (address: string) => cells.get(address),
    merges,
    columnWidths,
    rowHeights,
    frozen,
  };
}

/**
 * Map workbook sheet order -> worksheet XML path via the workbook relationships,
 * falling back to the conventional worksheets/sheetN.xml ordering.
 */
function resolveSheetPaths(files: Map<string, Buffer>, workbookXml: string): Array<{ name: string; path: string }> {
  const relsXml = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const relTargets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) relTargets.set(id, target.replace(/^\//, ''));
  }

  const result: Array<{ name: string; path: string }> = [];
  let fallbackIndex = 0;
  const sheetsSection = sectionOf(workbookXml, 'sheets');
  for (const m of sheetsSection.matchAll(/<sheet\b[^>]*\/>/g)) {
    fallbackIndex++;
    const name = attr(m[0], 'name') ?? `Sheet${fallbackIndex}`;
    const rid = attr(m[0], 'r:id') ?? attr(m[0], 'id');
    let target = rid ? relTargets.get(rid) : undefined;
    if (target && !target.startsWith('xl/')) target = `xl/${target}`;
    if (!target || !files.has(target)) target = `xl/worksheets/sheet${fallbackIndex}.xml`;
    result.push({ name, path: target });
  }
  return result;
}

export async function parseXlsxBuffer(buffer: Buffer): Promise<ParsedWorkbook> {
  const files = await unzipToMap(buffer);
  const workbookXml = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const sharedStrings = parseSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));
  const styles = parseStyles(files.get('xl/styles.xml')?.toString('utf8'));

  const sheetPaths = resolveSheetPaths(files, workbookXml);
  const sheets = sheetPaths.map(({ name, path }) => {
    const sheetXml = files.get(path)?.toString('utf8') ?? '';
    return parseSheet(name, sheetXml, sharedStrings, styles);
  });

  const coreXml = files.get('docProps/core.xml')?.toString('utf8') ?? '';
  const creator = coreXml.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/)?.[1];

  return {
    sheets,
    sheet: (name: string) => sheets.find(s => s.name === name),
    creator: creator ? decodeXml(creator) : undefined,
  };
}

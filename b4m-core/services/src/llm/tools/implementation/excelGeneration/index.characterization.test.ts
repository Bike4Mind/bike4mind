/**
 * Characterization tests for the excel_generation tool (issue #110).
 *
 * These lock the *observable output* of the tool - the actual bytes of the generated .xlsx,
 * re-parsed into logical content (values, formulas, resolved styles, merges, frozen panes) -
 * rather than the return string (covered in index.test.ts). They exist to PROVE parity when
 * the writer is migrated from `exceljs` to `write-excel-file`: the exact same assertions must
 * stay green against both implementations. They assert on re-parsed content, never on
 * byte-equality, and are deliberately writer-agnostic (see xlsxTestReader.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { excelGenerationTool } from './index';
import { parseXlsxBuffer, type ParsedWorkbook } from './xlsxTestReader';

const createMockContext = () => ({
  statusUpdate: vi.fn().mockResolvedValue(undefined),
  onFinish: vi.fn().mockResolvedValue(undefined),
  imageGenerateStorage: {
    upload: vi.fn().mockResolvedValue(undefined),
  },
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
});

type MockContext = ReturnType<typeof createMockContext>;

interface Generated {
  wb: ParsedWorkbook;
  result: string;
  /** The storage key the buffer was uploaded under (e.g. "report-1a2b3c4d.xlsx"). */
  storageKey: string;
  uploadOptions: { ContentType?: string; ContentDisposition?: string };
  ctx: MockContext;
}

async function generate(params: unknown): Promise<Generated> {
  const ctx = createMockContext();
  const { toolFn } = excelGenerationTool.implementation(ctx as any);
  const result = await toolFn(params);
  const call = ctx.imageGenerateStorage.upload.mock.calls[0];
  expect(call, 'upload was not called - generation failed').toBeTruthy();
  const [buffer, storageKey, uploadOptions] = call as [Buffer, string, any];
  const wb = await parseXlsxBuffer(buffer);
  return { wb, result, storageKey, uploadOptions, ctx };
}

/** Compare colors by their RGB portion only - writers differ on the ARGB alpha prefix. */
const rgb6 = (color?: string): string | undefined => color?.slice(-6);

describe('excel_generation characterization (re-parsed workbook)', () => {
  describe('cell values', () => {
    it('writes string, number, and boolean values with correct types', async () => {
      const { wb } = await generate({
        filename: 'values',
        sheets: [
          {
            name: 'Values',
            data: [
              { row: 1, col: 1, value: 'hello' },
              { row: 1, col: 2, value: 42 },
              { row: 1, col: 3, value: 3.14 },
              { row: 1, col: 4, value: 0 },
              { row: 1, col: 5, value: true },
              { row: 1, col: 6, value: false },
              { row: 1, col: 7, value: '' },
            ],
          },
        ],
      });
      const s = wb.sheet('Values')!;
      expect(s.cell('A1')!.value).toBe('hello');
      expect(s.cell('B1')!.value).toBe(42);
      expect(s.cell('C1')!.value).toBe(3.14);
      expect(s.cell('D1')!.value).toBe(0);
      expect(s.cell('E1')!.value).toBe(true);
      expect(s.cell('F1')!.value).toBe(false);
    });

    it('does not emit a populated cell for a null value', async () => {
      const { wb } = await generate({
        filename: 'nulls',
        sheets: [
          {
            name: 'Nulls',
            data: [
              { row: 1, col: 1, value: 'present' },
              { row: 2, col: 1, value: null },
            ],
          },
        ],
      });
      const s = wb.sheet('Nulls')!;
      expect(s.cell('A1')!.value).toBe('present');
      expect(s.cell('A2')).toBeUndefined();
    });
  });

  describe('multi-sheet', () => {
    it('preserves sheet order, names, and per-sheet content', async () => {
      const { wb } = await generate({
        filename: 'multi',
        sheets: [
          { name: 'First', data: [{ row: 1, col: 1, value: 'A' }] },
          { name: 'Second', data: [{ row: 1, col: 1, value: 'B' }] },
          { name: 'Third', data: [{ row: 1, col: 1, value: 'C' }] },
        ],
      });
      expect(wb.sheets.map(s => s.name)).toEqual(['First', 'Second', 'Third']);
      expect(wb.sheet('First')!.cell('A1')!.value).toBe('A');
      expect(wb.sheet('Second')!.cell('A1')!.value).toBe('B');
      expect(wb.sheet('Third')!.cell('A1')!.value).toBe('C');
    });

    it('accepts a sheet name at the 31-character maximum', async () => {
      const maxName = 'X'.repeat(31); // 31 = MAX_SHEET_NAME_LENGTH (Excel's hard limit)
      const { wb } = await generate({
        filename: 'maxname',
        sheets: [{ name: maxName, data: [{ row: 1, col: 1, value: 'v' }] }],
      });
      expect(wb.sheets[0].name).toBe(maxName);
    });

    it('rejects a sheet name longer than 31 characters', async () => {
      await expect(
        generate({ filename: 'overname', sheets: [{ name: 'X'.repeat(32), data: [{ row: 1, col: 1, value: 'v' }] }] })
      ).rejects.toThrow('Invalid parameters');
    });
  });

  describe('formulas', () => {
    it('stores a whitelisted formula as a formula, not a literal string', async () => {
      const { wb } = await generate({
        filename: 'formula',
        sheets: [
          {
            name: 'F',
            data: [
              { row: 1, col: 1, value: 10 },
              { row: 2, col: 1, value: 20 },
              { row: 3, col: 1, formula: '=SUM(A1:A2)' },
            ],
          },
        ],
      });
      const cell = wb.sheet('F')!.cell('A3')!;
      expect(cell.formula).toBe('SUM(A1:A2)');
    });

    it('adds a leading = to a formula supplied without one', async () => {
      const { wb } = await generate({
        filename: 'formula-noeq',
        sheets: [{ name: 'F', data: [{ row: 1, col: 1, formula: 'AVERAGE(B1:B9)' }] }],
      });
      expect(wb.sheet('F')!.cell('A1')!.formula).toBe('AVERAGE(B1:B9)');
    });
  });

  describe('formula-injection rejection', () => {
    const reject = async (formula: string) => {
      await expect(
        generate({ filename: 'x', sheets: [{ name: 'S', data: [{ row: 1, col: 1, formula }] }] })
      ).rejects.toThrow();
    };
    it('rejects CMD', async () => reject('=CMD("calc")'));
    it('rejects HYPERLINK', async () => reject('=HYPERLINK("http://evil")'));
    it('rejects WEBSERVICE', async () => reject('=WEBSERVICE("http://evil")'));
    it('rejects a non-whitelisted function', async () => reject('=DANGEROUS(A1)'));
  });

  describe('cell-value sanitization (formula-injection defense)', () => {
    // Each leading char that Excel would interpret as a formula must be neutralized by
    // prefixing a single quote, and the cell must NOT become a formula.
    for (const lead of ['=', '+', '-', '@', '\t', '\r', '\n']) {
      it(`prefixes a value starting with ${JSON.stringify(lead)} and keeps it a string`, async () => {
        const raw = `${lead}SUM(A1:A2)`;
        const { wb } = await generate({
          filename: 'sanitize',
          sheets: [{ name: 'S', data: [{ row: 1, col: 1, value: raw }] }],
        });
        const cell = wb.sheet('S')!.cell('A1')!;
        expect(cell.formula).toBeUndefined();
        expect(cell.value).toBe(`'${raw}`);
      });
    }

    it('leaves a safe string untouched', async () => {
      const { wb } = await generate({
        filename: 'safe',
        sheets: [{ name: 'S', data: [{ row: 1, col: 1, value: 'normal text' }] }],
      });
      expect(wb.sheet('S')!.cell('A1')!.value).toBe('normal text');
    });
  });

  describe('styling', () => {
    it('applies bold, italic, size, colors, alignment, number format, and borders', async () => {
      const { wb } = await generate({
        filename: 'styled',
        sheets: [
          {
            name: 'S',
            data: [
              {
                row: 1,
                col: 1,
                value: 1234.5,
                style: {
                  bold: true,
                  italic: true,
                  fontSize: 14,
                  fontColor: '#FF0000',
                  backgroundColor: '#FFFF00',
                  horizontalAlignment: 'center',
                  verticalAlignment: 'middle',
                  numberFormat: '#,##0.00',
                  border: { top: true, bottom: true, left: true, right: true },
                },
              },
            ],
          },
        ],
      });
      const style = wb.sheet('S')!.cell('A1')!.style!;
      expect(style.bold).toBe(true);
      expect(style.italic).toBe(true);
      expect(style.fontSize).toBe(14);
      expect(rgb6(style.fontColor)).toBe('FF0000');
      expect(rgb6(style.backgroundColor)).toBe('FFFF00');
      expect(style.horizontalAlignment).toBe('center');
      // Tool input 'middle' maps to OOXML vertical 'center'.
      expect(style.verticalAlignment).toBe('center');
      expect(style.numberFormat).toBe('#,##0.00');
      expect(style.border).toEqual({ top: true, bottom: true, left: true, right: true });
    });

    it('applies only the requested border sides', async () => {
      const { wb } = await generate({
        filename: 'borders',
        sheets: [
          {
            name: 'S',
            data: [{ row: 1, col: 1, value: 'x', style: { border: { top: true, left: true } } }],
          },
        ],
      });
      expect(wb.sheet('S')!.cell('A1')!.style!.border).toEqual({ top: true, left: true });
    });

    it('expands a 3-digit hex color', async () => {
      const { wb } = await generate({
        filename: 'shorthex',
        sheets: [{ name: 'S', data: [{ row: 1, col: 1, value: 'x', style: { fontColor: '#F00' } }] }],
      });
      expect(rgb6(wb.sheet('S')!.cell('A1')!.style!.fontColor)).toBe('FF0000');
    });

    it('falls back to black for an invalid color', async () => {
      const { wb } = await generate({
        filename: 'badcolor',
        sheets: [{ name: 'S', data: [{ row: 1, col: 1, value: 'x', style: { fontColor: 'not-a-color' } }] }],
      });
      expect(rgb6(wb.sheet('S')!.cell('A1')!.style!.fontColor)).toBe('000000');
    });

    // write-excel-file throws if a number format lands on a String/Boolean cell (exceljs ignored
    // it). The tool must drop the incompatible format instead of failing the whole workbook.
    it('drops a number format on a string cell without crashing', async () => {
      const { wb } = await generate({
        filename: 'strfmt',
        sheets: [{ name: 'S', data: [{ row: 1, col: 1, value: 'label', style: { numberFormat: '#,##0.00' } }] }],
      });
      const cell = wb.sheet('S')!.cell('A1')!;
      expect(cell.value).toBe('label');
      expect(cell.style?.numberFormat).toBeUndefined();
    });

    it('drops a number format on a boolean cell without crashing', async () => {
      const { wb } = await generate({
        filename: 'boolfmt',
        sheets: [{ name: 'S', data: [{ row: 1, col: 1, value: true, style: { numberFormat: '0%' } }] }],
      });
      const cell = wb.sheet('S')!.cell('A1')!;
      expect(cell.value).toBe(true);
      expect(cell.style?.numberFormat).toBeUndefined();
    });

    it('keeps a number format on a numeric cell', async () => {
      const { wb } = await generate({
        filename: 'numfmt',
        sheets: [{ name: 'S', data: [{ row: 1, col: 1, value: 0.25, style: { numberFormat: '0%' } }] }],
      });
      expect(wb.sheet('S')!.cell('A1')!.style!.numberFormat).toBe('0%');
    });
  });

  describe('layout features', () => {
    it('applies column widths and row heights', async () => {
      const { wb } = await generate({
        filename: 'layout',
        sheets: [
          {
            name: 'S',
            data: [{ row: 2, col: 1, value: 'x' }],
            columnWidths: [
              { col: 1, width: 20 },
              { col: 3, width: 45 },
            ],
            rowHeights: [{ row: 2, height: 30 }],
          },
        ],
      });
      const s = wb.sheet('S')!;
      expect(s.columnWidths.get(1)).toBe(20);
      expect(s.columnWidths.get(3)).toBe(45);
      expect(s.rowHeights.get(2)).toBe(30);
    });

    it('applies merged cell ranges', async () => {
      const { wb } = await generate({
        filename: 'merge',
        sheets: [
          {
            name: 'S',
            data: [{ row: 1, col: 1, value: 'title' }],
            mergedCells: [{ startRow: 1, startCol: 1, endRow: 3, endCol: 3 }],
          },
        ],
      });
      expect(wb.sheet('S')!.merges).toContain('A1:C3');
    });

    // A row height on a row whose only column-1 cell is hidden by a vertical merge used to write a
    // non-null cell into the covered position, which makes write-excel-file throw. It must not.
    it('sets a row height on a row whose first column is merge-covered', async () => {
      const { wb } = await generate({
        filename: 'merge-rowheight',
        sheets: [
          {
            name: 'S',
            data: [{ row: 1, col: 1, value: 'label' }],
            mergedCells: [{ startRow: 1, startCol: 1, endRow: 3, endCol: 1 }], // A1:A3, so A3 is covered
            rowHeights: [{ row: 3, height: 40 }], // row 3 has no other populated cell
          },
        ],
      });
      const s = wb.sheet('S')!;
      expect(s.merges).toContain('A1:A3');
      // The merge and its anchor value survive; generation did not throw.
      expect(s.cell('A1')!.value).toBe('label');
    });

    it('freezes both axes', async () => {
      const { wb } = await generate({
        filename: 'freeze',
        sheets: [{ name: 'S', data: [{ row: 1, col: 1, value: 'x' }], freezePane: { row: 2, col: 2 } }],
      });
      expect(wb.sheet('S')!.frozen).toEqual({ xSplit: 1, ySplit: 1 });
    });

    it('freezes rows only (col defaults to no freeze)', async () => {
      const { wb } = await generate({
        filename: 'freeze-row',
        sheets: [{ name: 'S', data: [{ row: 1, col: 1, value: 'x' }], freezePane: { row: 3 } }],
      });
      expect(wb.sheet('S')!.frozen).toEqual({ xSplit: 0, ySplit: 2 });
    });

    it('freezes columns only (row defaults to no freeze)', async () => {
      const { wb } = await generate({
        filename: 'freeze-col',
        sheets: [{ name: 'S', data: [{ row: 1, col: 1, value: 'x' }], freezePane: { col: 4 } }],
      });
      expect(wb.sheet('S')!.frozen).toEqual({ xSplit: 3, ySplit: 0 });
    });

    it('does not freeze when both axes default to 1 (no-op)', async () => {
      const { wb } = await generate({
        filename: 'freeze-none',
        sheets: [{ name: 'S', data: [{ row: 1, col: 1, value: 'x' }], freezePane: {} }],
      });
      expect(wb.sheet('S')!.frozen).toBeUndefined();
    });
  });

  describe('storage key and filename', () => {
    it('appends an 8-char uuid suffix and .xlsx to the sanitized name', async () => {
      const { storageKey } = await generate({
        filename: 'My Report',
        sheets: [{ name: 'S', data: [{ row: 1, col: 1, value: 'x' }] }],
      });
      expect(storageKey).toMatch(/^My Report-[0-9a-f]{8}\.xlsx$/);
    });

    it('sanitizes dangerous filename characters in the storage key', async () => {
      const { storageKey } = await generate({
        filename: 'a/b:c*d?.xlsx',
        sheets: [{ name: 'S', data: [{ row: 1, col: 1, value: 'x' }] }],
      });
      // Trailing "_" comes from the "?" before ".xlsx" (extension stripped first, then sanitized).
      expect(storageKey).toMatch(/^a_b_c_d_-[0-9a-f]{8}\.xlsx$/);
    });

    it('sets an attachment ContentDisposition using the human-friendly .xlsx name', async () => {
      const { uploadOptions } = await generate({
        filename: 'Quarterly',
        sheets: [{ name: 'S', data: [{ row: 1, col: 1, value: 'x' }] }],
      });
      expect(uploadOptions.ContentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(uploadOptions.ContentDisposition).toBe('attachment; filename="Quarterly.xlsx"');
    });
  });
});

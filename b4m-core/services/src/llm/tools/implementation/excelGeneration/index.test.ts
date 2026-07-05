import { describe, it, expect, vi, beforeEach } from 'vitest';
import { excelGenerationTool } from './index';

// Mock context for the tool
const createMockContext = () => ({
  statusUpdate: vi.fn().mockResolvedValue(undefined),
  onFinish: vi.fn().mockResolvedValue(undefined),
  imageGenerateStorage: {
    upload: vi.fn().mockResolvedValue(undefined),
  },
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
});

describe('excel_generation', () => {
  let mockContext: ReturnType<typeof createMockContext>;
  let toolFn: (value: unknown) => Promise<string>;

  beforeEach(() => {
    mockContext = createMockContext();
    const implementation = excelGenerationTool.implementation(mockContext as any);
    toolFn = implementation.toolFn;
  });

  describe('valid generation', () => {
    it('should generate a basic Excel file with single sheet', async () => {
      const params = {
        filename: 'test-file',
        sheets: [
          {
            name: 'Sheet1',
            data: [
              { row: 1, col: 1, value: 'Header' },
              { row: 2, col: 1, value: 100 },
            ],
          },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
      expect(result).toContain('test-file.xlsx');
      expect(mockContext.imageGenerateStorage.upload).toHaveBeenCalledTimes(1);
      expect(mockContext.onFinish).toHaveBeenCalledWith('excel_generation', expect.any(Array));
    });

    it('should generate Excel with multiple sheets', async () => {
      const params = {
        filename: 'multi-sheet',
        sheets: [
          { name: 'Sheet1', data: [{ row: 1, col: 1, value: 'A' }] },
          { name: 'Sheet2', data: [{ row: 1, col: 1, value: 'B' }] },
          { name: 'Sheet3', data: [{ row: 1, col: 1, value: 'C' }] },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
      expect(mockContext.imageGenerateStorage.upload).toHaveBeenCalledTimes(1);
    });

    it('should handle boolean and null values', async () => {
      const params = {
        filename: 'types-test',
        sheets: [
          {
            name: 'Types',
            data: [
              { row: 1, col: 1, value: true },
              { row: 2, col: 1, value: false },
              { row: 3, col: 1, value: null },
              { row: 4, col: 1, value: 'text' },
              { row: 5, col: 1, value: 42 },
            ],
          },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
    });
  });

  describe('style application', () => {
    it('should apply cell styling', async () => {
      const params = {
        filename: 'styled',
        sheets: [
          {
            name: 'Styled',
            data: [
              {
                row: 1,
                col: 1,
                value: 'Bold Header',
                style: {
                  bold: true,
                  italic: true,
                  fontSize: 14,
                  fontColor: '#FF0000',
                  backgroundColor: '#FFFF00',
                  horizontalAlignment: 'center' as const,
                  verticalAlignment: 'middle' as const,
                  border: { top: true, bottom: true, left: true, right: true },
                },
              },
            ],
          },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
    });

    it('should handle 3-digit hex colors', async () => {
      const params = {
        filename: 'short-hex',
        sheets: [
          {
            name: 'Colors',
            data: [
              {
                row: 1,
                col: 1,
                value: 'Red',
                style: { fontColor: '#F00' },
              },
            ],
          },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
    });

    it('should handle invalid color gracefully', async () => {
      const params = {
        filename: 'bad-color',
        sheets: [
          {
            name: 'Colors',
            data: [
              {
                row: 1,
                col: 1,
                value: 'Test',
                style: { fontColor: 'notacolor' },
              },
            ],
          },
        ],
      };

      // Should not throw, should use default color
      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
    });

    it('should apply number formats', async () => {
      const params = {
        filename: 'formats',
        sheets: [
          {
            name: 'Formatted',
            data: [
              { row: 1, col: 1, value: 1234.56, style: { numberFormat: '$#,##0.00' } },
              { row: 2, col: 1, value: 0.75, style: { numberFormat: '0%' } },
            ],
          },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
    });
  });

  describe('formula handling', () => {
    it('should allow safe formulas', async () => {
      const params = {
        filename: 'formulas',
        sheets: [
          {
            name: 'Calculations',
            data: [
              { row: 1, col: 1, value: 10 },
              { row: 2, col: 1, value: 20 },
              { row: 3, col: 1, formula: '=SUM(A1:A2)' },
              { row: 4, col: 1, formula: '=AVERAGE(A1:A2)' },
              { row: 5, col: 1, formula: '=IF(A1>5,"High","Low")' },
            ],
          },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
    });

    it('should reject dangerous CMD formula', async () => {
      const params = {
        filename: 'dangerous',
        sheets: [
          {
            name: 'Bad',
            data: [{ row: 1, col: 1, formula: '=CMD("dir")' }],
          },
        ],
      };

      await expect(toolFn(params)).rejects.toThrow('disallowed pattern');
    });

    it('should reject HYPERLINK formula', async () => {
      const params = {
        filename: 'dangerous',
        sheets: [
          {
            name: 'Bad',
            data: [{ row: 1, col: 1, formula: '=HYPERLINK("http://evil.com","Click")' }],
          },
        ],
      };

      await expect(toolFn(params)).rejects.toThrow('disallowed pattern');
    });

    it('should reject WEBSERVICE formula', async () => {
      const params = {
        filename: 'dangerous',
        sheets: [
          {
            name: 'Bad',
            data: [{ row: 1, col: 1, formula: '=WEBSERVICE("http://evil.com")' }],
          },
        ],
      };

      await expect(toolFn(params)).rejects.toThrow('disallowed pattern');
    });

    it('should reject unknown functions', async () => {
      const params = {
        filename: 'dangerous',
        sheets: [
          {
            name: 'Bad',
            data: [{ row: 1, col: 1, formula: '=DANGEROUSFUNC(A1)' }],
          },
        ],
      };

      await expect(toolFn(params)).rejects.toThrow('disallowed function');
    });
  });

  describe('cell value sanitization', () => {
    it('should sanitize values starting with = to prevent formula injection', async () => {
      const params = {
        filename: 'sanitize',
        sheets: [
          {
            name: 'Data',
            data: [
              { row: 1, col: 1, value: '=SUM(A1:A10)' }, // Should be prefixed with '
              { row: 2, col: 1, value: '+1234567890' }, // Should be prefixed with '
              { row: 3, col: 1, value: '-CMD|...' }, // Should be prefixed with '
              { row: 4, col: 1, value: '@evil' }, // Should be prefixed with '
            ],
          },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
    });
  });

  describe('resource limits', () => {
    it('should reject more than 10 sheets', async () => {
      const sheets = Array.from({ length: 11 }, (_, i) => ({
        name: `Sheet${i + 1}`,
        data: [{ row: 1, col: 1, value: 'test' }],
      }));

      const params = { filename: 'too-many-sheets', sheets };

      await expect(toolFn(params)).rejects.toThrow('Invalid parameters');
    });

    it('should reject rows exceeding limit', async () => {
      const params = {
        filename: 'bad-row',
        sheets: [
          {
            name: 'Sheet1',
            data: [{ row: 1001, col: 1, value: 'test' }],
          },
        ],
      };

      await expect(toolFn(params)).rejects.toThrow('Invalid parameters');
    });

    it('should reject columns exceeding limit', async () => {
      const params = {
        filename: 'bad-col',
        sheets: [
          {
            name: 'Sheet1',
            data: [{ row: 1, col: 101, value: 'test' }],
          },
        ],
      };

      await expect(toolFn(params)).rejects.toThrow('Invalid parameters');
    });

    it('should reject rows less than 1', async () => {
      const params = {
        filename: 'bad-row',
        sheets: [
          {
            name: 'Sheet1',
            data: [{ row: 0, col: 1, value: 'test' }],
          },
        ],
      };

      await expect(toolFn(params)).rejects.toThrow('Invalid parameters');
    });

    it('should reject columns less than 1', async () => {
      const params = {
        filename: 'bad-col',
        sheets: [
          {
            name: 'Sheet1',
            data: [{ row: 1, col: 0, value: 'test' }],
          },
        ],
      };

      await expect(toolFn(params)).rejects.toThrow('Invalid parameters');
    });
  });

  describe('input validation', () => {
    it('should reject missing filename', async () => {
      const params = {
        sheets: [{ name: 'Sheet1', data: [{ row: 1, col: 1, value: 'test' }] }],
      };

      await expect(toolFn(params)).rejects.toThrow('Invalid parameters');
    });

    it('should reject empty filename', async () => {
      const params = {
        filename: '',
        sheets: [{ name: 'Sheet1', data: [{ row: 1, col: 1, value: 'test' }] }],
      };

      await expect(toolFn(params)).rejects.toThrow('Invalid parameters');
    });

    it('should reject missing sheets', async () => {
      const params = { filename: 'test' };

      await expect(toolFn(params)).rejects.toThrow('Invalid parameters');
    });

    it('should reject empty sheets array', async () => {
      const params = { filename: 'test', sheets: [] };

      await expect(toolFn(params)).rejects.toThrow('Invalid parameters');
    });

    it('should reject sheets as non-array', async () => {
      const params = { filename: 'test', sheets: 'not-an-array' };

      await expect(toolFn(params)).rejects.toThrow('Invalid parameters');
    });

    it('should reject sheet with missing name', async () => {
      const params = {
        filename: 'test',
        sheets: [{ data: [{ row: 1, col: 1, value: 'test' }] }],
      };

      await expect(toolFn(params)).rejects.toThrow('Invalid parameters');
    });

    it('should reject sheet with missing data', async () => {
      const params = {
        filename: 'test',
        sheets: [{ name: 'Sheet1' }],
      };

      await expect(toolFn(params)).rejects.toThrow('Invalid parameters');
    });

    it('should reject cell with missing row', async () => {
      const params = {
        filename: 'test',
        sheets: [{ name: 'Sheet1', data: [{ col: 1, value: 'test' }] }],
      };

      await expect(toolFn(params)).rejects.toThrow('Invalid parameters');
    });

    it('should reject cell with missing col', async () => {
      const params = {
        filename: 'test',
        sheets: [{ name: 'Sheet1', data: [{ row: 1, value: 'test' }] }],
      };

      await expect(toolFn(params)).rejects.toThrow('Invalid parameters');
    });
  });

  describe('sheet features', () => {
    it('should handle column widths', async () => {
      const params = {
        filename: 'widths',
        sheets: [
          {
            name: 'Sheet1',
            data: [{ row: 1, col: 1, value: 'Wide column' }],
            columnWidths: [{ col: 1, width: 30 }],
          },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
    });

    it('should handle row heights', async () => {
      const params = {
        filename: 'heights',
        sheets: [
          {
            name: 'Sheet1',
            data: [{ row: 1, col: 1, value: 'Tall row' }],
            rowHeights: [{ row: 1, height: 50 }],
          },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
    });

    it('should handle merged cells', async () => {
      const params = {
        filename: 'merged',
        sheets: [
          {
            name: 'Sheet1',
            data: [{ row: 1, col: 1, value: 'Merged header' }],
            mergedCells: [{ startRow: 1, startCol: 1, endRow: 1, endCol: 3 }],
          },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
    });

    it('should handle freeze panes', async () => {
      const params = {
        filename: 'frozen',
        sheets: [
          {
            name: 'Sheet1',
            data: [
              { row: 1, col: 1, value: 'Header' },
              { row: 2, col: 1, value: 'Data' },
            ],
            freezePane: { row: 2, col: 1 },
          },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
    });

    it('should handle freeze panes with only row (col defaults to 1)', async () => {
      const params = {
        filename: 'frozen-row-only',
        sheets: [
          {
            name: 'Sheet1',
            data: [
              { row: 1, col: 1, value: 'Header' },
              { row: 2, col: 1, value: 'Data' },
            ],
            freezePane: { row: 2 },
          },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
    });

    it('should handle freeze panes with only col (row defaults to 1)', async () => {
      const params = {
        filename: 'frozen-col-only',
        sheets: [
          {
            name: 'Sheet1',
            data: [
              { row: 1, col: 1, value: 'Header' },
              { row: 2, col: 1, value: 'Data' },
            ],
            freezePane: { col: 2 },
          },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
    });

    it('should handle empty freezePane object (both default to 1, no-op)', async () => {
      const params = {
        filename: 'frozen-empty',
        sheets: [
          {
            name: 'Sheet1',
            data: [{ row: 1, col: 1, value: 'Data' }],
            freezePane: {},
          },
        ],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
    });
  });

  describe('filename sanitization', () => {
    it('should sanitize dangerous characters in filename', async () => {
      const params = {
        filename: 'test<>:"/\\|?*file',
        sheets: [{ name: 'Sheet1', data: [{ row: 1, col: 1, value: 'test' }] }],
      };

      const result = await toolFn(params);

      expect(result).toContain('Successfully generated Excel file');
      // The upload should have been called with a sanitized filename
      const uploadCall = mockContext.imageGenerateStorage.upload.mock.calls[0];
      expect(uploadCall[1]).not.toContain('<');
      expect(uploadCall[1]).not.toContain('>');
    });

    it('should handle filename with .xlsx extension', async () => {
      const params = {
        filename: 'test.xlsx',
        sheets: [{ name: 'Sheet1', data: [{ row: 1, col: 1, value: 'test' }] }],
      };

      const result = await toolFn(params);

      expect(result).toContain('test.xlsx');
    });
  });
});

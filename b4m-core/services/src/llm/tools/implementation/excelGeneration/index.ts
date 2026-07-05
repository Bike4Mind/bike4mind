import { ToolContext, ToolDefinition } from '../../base/types';
import ExcelJS from 'exceljs';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { persistGeneratedFileAsFabFile } from '../../helpers/persistGeneratedFile';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Resource limits to prevent DoS
const LIMITS = {
  MAX_SHEETS: 10,
  MAX_CELLS_PER_SHEET: 10000,
  MAX_ROW: 1000,
  MAX_COL: 100,
  MAX_COLUMN_WIDTH: 500,
  MAX_ROW_HEIGHT: 500,
  MAX_SHEET_NAME_LENGTH: 31,
} as const;

// Whitelist of allowed Excel formula functions (safe subset)
const ALLOWED_FORMULA_FUNCTIONS = new Set([
  // Math functions
  'SUM',
  'AVERAGE',
  'MIN',
  'MAX',
  'COUNT',
  'COUNTA',
  'COUNTIF',
  'COUNTIFS',
  'SUMIF',
  'SUMIFS',
  'AVERAGEIF',
  'AVERAGEIFS',
  'ROUND',
  'ROUNDUP',
  'ROUNDDOWN',
  'ABS',
  'SQRT',
  'POWER',
  'MOD',
  'INT',
  'CEILING',
  'FLOOR',
  'PRODUCT',
  'MEDIAN',
  'STDEV',
  'VAR',
  // Trigonometric functions
  'SIN',
  'COS',
  'TAN',
  'ASIN',
  'ACOS',
  'ATAN',
  'ATAN2',
  'RADIANS',
  'DEGREES',
  'PI',
  // Scientific/logarithmic functions
  'LOG',
  'LN',
  'EXP',
  'LOG10',
  // Logical functions
  'IF',
  'AND',
  'OR',
  'NOT',
  'TRUE',
  'FALSE',
  'IFERROR',
  'IFNA',
  'IFS',
  // Text functions
  'CONCATENATE',
  'CONCAT',
  'LEFT',
  'RIGHT',
  'MID',
  'LEN',
  'TRIM',
  'UPPER',
  'LOWER',
  'PROPER',
  'TEXT',
  'VALUE',
  'SUBSTITUTE',
  'REPLACE',
  'FIND',
  'SEARCH',
  // Lookup functions
  'VLOOKUP',
  'HLOOKUP',
  'INDEX',
  'MATCH',
  'LOOKUP',
  'XLOOKUP',
  'CHOOSE',
  // Date functions
  'DATE',
  'TODAY',
  'NOW',
  'YEAR',
  'MONTH',
  'DAY',
  'HOUR',
  'MINUTE',
  'SECOND',
  'WEEKDAY',
  'DATEVALUE',
  'DATEDIF',
  'EDATE',
  'EOMONTH',
  // Financial functions
  'PMT',
  'PV',
  'FV',
  'NPV',
  'IRR',
  'RATE',
  // Other safe functions
  'ROW',
  'COLUMN',
  'ROWS',
  'COLUMNS',
  'OFFSET',
  'INDIRECT',
  'ADDRESS',
  'ISBLANK',
  'ISERROR',
  'ISNUMBER',
  'ISTEXT',
]);

// Dangerous patterns that should never appear in formulas
const DANGEROUS_PATTERNS = [
  /\bCMD\b/i,
  /\bEXEC\b/i,
  /\bSHELL\b/i,
  /\bCALL\b/i,
  /\bREGISTER\.ID\b/i,
  /\bRUN\b/i,
  /\bWEBSERVICE\b/i,
  /\bFILTERXML\b/i,
  /\bHYPERLINK\s*\(/i,
  /javascript:/i,
  /vbscript:/i,
  /data:/i,
  /file:/i,
];

/**
 * Validates and sanitizes a formula to prevent injection attacks.
 * Returns the sanitized formula or throws an error if dangerous.
 */
function validateFormula(formula: string): string {
  // Remove leading = if present for analysis
  const cleanFormula = formula.startsWith('=') ? formula.slice(1) : formula;

  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cleanFormula)) {
      throw new Error(`Formula contains disallowed pattern: ${formula}`);
    }
  }

  // Extract function names from the formula
  const functionMatches = cleanFormula.match(/[A-Z_][A-Z0-9_]*(?=\s*\()/gi) || [];

  // Verify all functions are in the whitelist
  for (const func of functionMatches) {
    if (!ALLOWED_FORMULA_FUNCTIONS.has(func.toUpperCase())) {
      throw new Error(`Formula contains disallowed function '${func}': ${formula}`);
    }
  }

  // Ensure formula starts with =
  return formula.startsWith('=') ? formula : `=${formula}`;
}

/**
 * Sanitizes cell values that could be interpreted as formulas.
 * Values starting with =, +, -, @, or tab could trigger formula execution.
 */
function sanitizeCellValue(value: string | number | boolean | null): string | number | boolean | null {
  if (typeof value !== 'string') {
    return value;
  }

  // Check if value starts with dangerous characters
  const dangerousStarts = ['=', '+', '-', '@', '\t', '\r', '\n'];
  if (dangerousStarts.some(char => value.startsWith(char))) {
    // Prefix with single quote to treat as text
    return `'${value}`;
  }

  return value;
}

/**
 * Converts color input to ARGB format for ExcelJS.
 * Handles 6-digit hex (#RRGGBB), 3-digit hex (#RGB), and provides fallback.
 */
function colorToArgb(color: string): string {
  if (!color) return 'FF000000'; // Default black

  // Remove # if present
  let hex = color.replace('#', '');

  // Handle 3-digit hex (#RGB -> #RRGGBB)
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map(c => c + c)
      .join('');
  }

  // Validate it's a valid 6-character hex
  if (!/^[0-9A-Fa-f]{6}$/.test(hex)) {
    // Return default black for invalid colors (named colors, etc.)
    return 'FF000000';
  }

  // Prepend FF for full opacity
  return `FF${hex.toUpperCase()}`;
}

// Zod schemas for input validation
const CellStyleSchema = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    fontSize: z.number().min(6).max(72).optional(),
    fontColor: z.string().optional(),
    backgroundColor: z.string().optional(),
    horizontalAlignment: z.enum(['left', 'center', 'right']).optional(),
    verticalAlignment: z.enum(['top', 'middle', 'bottom']).optional(),
    numberFormat: z.string().max(100).optional(),
    border: z
      .object({
        top: z.boolean().optional(),
        bottom: z.boolean().optional(),
        left: z.boolean().optional(),
        right: z.boolean().optional(),
      })
      .optional(),
  })
  .optional();

const CellDataSchema = z.object({
  row: z.number().int().min(1).max(LIMITS.MAX_ROW),
  col: z.number().int().min(1).max(LIMITS.MAX_COL),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  formula: z.string().max(1000).optional(),
  style: CellStyleSchema,
});

const SheetDataSchema = z.object({
  name: z.string().min(1).max(LIMITS.MAX_SHEET_NAME_LENGTH),
  data: z.array(CellDataSchema).max(LIMITS.MAX_CELLS_PER_SHEET),
  columnWidths: z
    .array(
      z.object({
        col: z.number().int().min(1).max(LIMITS.MAX_COL),
        width: z.number().min(1).max(LIMITS.MAX_COLUMN_WIDTH),
      })
    )
    .optional(),
  rowHeights: z
    .array(
      z.object({
        row: z.number().int().min(1).max(LIMITS.MAX_ROW),
        height: z.number().min(1).max(LIMITS.MAX_ROW_HEIGHT),
      })
    )
    .optional(),
  mergedCells: z
    .array(
      z.object({
        startRow: z.number().int().min(1).max(LIMITS.MAX_ROW),
        startCol: z.number().int().min(1).max(LIMITS.MAX_COL),
        endRow: z.number().int().min(1).max(LIMITS.MAX_ROW),
        endCol: z.number().int().min(1).max(LIMITS.MAX_COL),
      })
    )
    .optional(),
  freezePane: z
    .object({
      row: z.number().int().min(1).max(LIMITS.MAX_ROW).default(1),
      col: z.number().int().min(1).max(LIMITS.MAX_COL).default(1),
    })
    .optional(),
});

const ExcelGenerationParamsSchema = z.object({
  filename: z.string().min(1).max(200),
  sheets: z.array(SheetDataSchema).min(1).max(LIMITS.MAX_SHEETS),
});

type CellStyle = z.infer<typeof CellStyleSchema>;
type ExcelGenerationParams = z.infer<typeof ExcelGenerationParamsSchema>;

/**
 * Applies cell styling to an ExcelJS cell
 */
function applyCellStyle(cell: ExcelJS.Cell, style: NonNullable<CellStyle>): void {
  // Font styling
  const font: Partial<ExcelJS.Font> = {};
  if (style.bold !== undefined) font.bold = style.bold;
  if (style.italic !== undefined) font.italic = style.italic;
  if (style.fontSize !== undefined) font.size = style.fontSize;
  if (style.fontColor) {
    font.color = { argb: colorToArgb(style.fontColor) };
  }
  if (Object.keys(font).length > 0) {
    cell.font = font;
  }

  // Fill/background
  if (style.backgroundColor) {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: colorToArgb(style.backgroundColor) },
    };
  }

  // Alignment
  const alignment: Partial<ExcelJS.Alignment> = {};
  if (style.horizontalAlignment) alignment.horizontal = style.horizontalAlignment;
  if (style.verticalAlignment) alignment.vertical = style.verticalAlignment;
  if (Object.keys(alignment).length > 0) {
    cell.alignment = alignment;
  }

  // Number format
  if (style.numberFormat) {
    cell.numFmt = style.numberFormat;
  }

  // Borders
  if (style.border) {
    const borderStyle: Partial<ExcelJS.Border> = { style: 'thin' };
    const borders: Partial<ExcelJS.Borders> = {};
    if (style.border.top) borders.top = borderStyle;
    if (style.border.bottom) borders.bottom = borderStyle;
    if (style.border.left) borders.left = borderStyle;
    if (style.border.right) borders.right = borderStyle;
    if (Object.keys(borders).length > 0) {
      cell.border = borders;
    }
  }
}

/**
 * Generates an Excel workbook buffer from the provided parameters
 */
async function generateExcel(params: ExcelGenerationParams): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  // Generic "AI" creator when APP_NAME is unset (brand is externalized).
  const brand = process.env.APP_NAME || '';
  workbook.creator = brand ? `${brand} AI` : 'AI';
  workbook.created = new Date();

  for (const sheetData of params.sheets) {
    // Excel sheet names are limited to 31 characters
    const worksheet = workbook.addWorksheet(sheetData.name.slice(0, LIMITS.MAX_SHEET_NAME_LENGTH));

    // Set column widths
    if (sheetData.columnWidths) {
      for (const cw of sheetData.columnWidths) {
        worksheet.getColumn(cw.col).width = cw.width;
      }
    }

    // Set row heights
    if (sheetData.rowHeights) {
      for (const rh of sheetData.rowHeights) {
        worksheet.getRow(rh.row).height = rh.height;
      }
    }

    // Add data and styling
    for (const cellData of sheetData.data) {
      const cell = worksheet.getCell(cellData.row, cellData.col);

      if (cellData.formula) {
        // Validate and sanitize formula before using
        const sanitizedFormula = validateFormula(cellData.formula);
        cell.value = { formula: sanitizedFormula };
      } else if (cellData.value !== null && cellData.value !== undefined) {
        // Sanitize cell values to prevent formula injection
        cell.value = sanitizeCellValue(cellData.value);
      }

      if (cellData.style) {
        applyCellStyle(cell, cellData.style);
      }
    }

    // Merged cells
    if (sheetData.mergedCells) {
      for (const mc of sheetData.mergedCells) {
        worksheet.mergeCells(mc.startRow, mc.startCol, mc.endRow, mc.endCol);
      }
    }

    // Freeze panes (only apply if at least one axis actually freezes)
    if (sheetData.freezePane) {
      const xSplit = sheetData.freezePane.col - 1;
      const ySplit = sheetData.freezePane.row - 1;
      if (xSplit > 0 || ySplit > 0) {
        worksheet.views = [{ state: 'frozen', xSplit, ySplit }];
      }
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Sanitizes a filename for safe storage
 */
function sanitizeFilename(filename: string): string {
  // Remove .xlsx extension if present (we'll add it back)
  let name = filename.replace(/\.xlsx$/i, '');
  // Remove dangerous characters (including control chars U+0000-U+001F)
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  // Limit length
  name = name.slice(0, 100);
  // Ensure it's not empty
  if (!name) name = 'spreadsheet';
  return name;
}

export const excelGenerationTool: ToolDefinition = {
  name: 'excel_generation',
  implementation: (context: ToolContext) => ({
    toolFn: async (value: unknown) => {
      // Validate input with Zod
      const parseResult = ExcelGenerationParamsSchema.safeParse(value);
      if (!parseResult.success) {
        const errors = parseResult.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
        throw new Error(`Invalid parameters: ${errors}`);
      }

      const params = parseResult.data;

      await context.statusUpdate({}, 'Generating Excel file...');

      try {
        // Generate the Excel buffer
        const buffer = await generateExcel(params);

        // Sanitize the user-provided filename and use it for storage
        const sanitizedName = sanitizeFilename(params.filename);
        const filename = `${sanitizedName}-${uuidv4().slice(0, 8)}.xlsx`;

        // Upload to generated content storage (same bucket as images)
        await context.imageGenerateStorage.upload(buffer, filename, {
          ContentType: XLSX_MIME,
          ContentDisposition: `attachment; filename="${sanitizedName}.xlsx"`,
        });

        // Persist as a session FabFile so the spreadsheet is browsable + downloadable in the
        // Knowledge Base. This is the primary surface for Excel: unlike an image, an .xlsx in
        // quest.images renders as a broken <img>, so without this the user has no way to get
        // the file. Best-effort - failure here doesn't fail the tool. Use the human-friendly
        // ".xlsx" name (not the uuid storage key) so the Knowledge Base shows a readable title.
        await persistGeneratedFileAsFabFile(context, {
          fileName: `${sanitizedName}.xlsx`,
          mimeType: XLSX_MIME,
          content: buffer,
        });

        // Store in quest's images array for client display
        await context.onFinish?.('excel_generation', [filename]);
        await context.statusUpdate({ images: [filename] });

        return `Successfully generated Excel file: ${sanitizedName}.xlsx`;
      } catch (error) {
        context.logger.error('Excel generation failed:', error);
        throw new Error(`Failed to generate Excel file: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    },
    toolSchema: {
      name: 'excel_generation',
      description: `Generate a well-formed Excel (.xlsx) workbook. Supports: multiple sheets, formulas (SUM, AVERAGE, IF, VLOOKUP, etc.; only a safe whitelisted subset), styling (bold, colors, borders), number formats, merged cells, frozen panes.

HARD LIMITS (the request is REJECTED if any are exceeded, not truncated, so data is never silently dropped):
- At most ${LIMITS.MAX_SHEETS} sheets per workbook.
- At most ${LIMITS.MAX_CELLS_PER_SHEET} populated cells per sheet (count the cell objects you pass in "data", not the grid area).
- Row numbers 1-${LIMITS.MAX_ROW} and column numbers 1-${LIMITS.MAX_COL} only.
- Sheet names: 1-${LIMITS.MAX_SHEET_NAME_LENGTH} characters.
- Formulas may only use whitelisted functions; volatile/external ones (HYPERLINK, WEBSERVICE, CMD, etc.) are blocked.

Addressing is 1-indexed numeric row/col (row 1, col 1 = cell A1); do NOT pass A1-style strings. Provide only the cells you want populated; empty cells need no entry.

Before calling: if the user's request would exceed any limit (e.g. a dataset larger than ${LIMITS.MAX_CELLS_PER_SHEET} cells or more than ${LIMITS.MAX_SHEETS} sheets), do not promise the full result; tell the user what you can deliver within these limits and either split the data across sheets/files or summarize. Only commit to what this tool can actually produce.`,
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Name for the Excel file (without .xlsx extension)',
          },
          sheets: {
            type: 'array',
            description: 'Array of sheet definitions',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Sheet name (max 31 characters)',
                },
                data: {
                  type: 'array',
                  description: 'Cell data array',
                  items: {
                    type: 'object',
                    properties: {
                      row: { type: 'number', description: '1-indexed row number' },
                      col: { type: 'number', description: '1-indexed column number' },
                      value: { description: 'Cell value (string, number, boolean, or null)' },
                      formula: { type: 'string', description: 'Excel formula (e.g., =SUM(A1:A10))' },
                      style: {
                        type: 'object',
                        description: 'Cell styling options',
                        properties: {
                          bold: { type: 'boolean' },
                          italic: { type: 'boolean' },
                          fontSize: { type: 'number' },
                          fontColor: { type: 'string', description: 'Hex color (e.g., #FF0000)' },
                          backgroundColor: { type: 'string', description: 'Hex color' },
                          horizontalAlignment: { type: 'string', enum: ['left', 'center', 'right'] },
                          verticalAlignment: { type: 'string', enum: ['top', 'middle', 'bottom'] },
                          numberFormat: {
                            type: 'string',
                            description: 'Excel number format (e.g., #,##0.00, 0%, yyyy-mm-dd)',
                          },
                          border: {
                            type: 'object',
                            properties: {
                              top: { type: 'boolean' },
                              bottom: { type: 'boolean' },
                              left: { type: 'boolean' },
                              right: { type: 'boolean' },
                            },
                          },
                        },
                      },
                    },
                    required: ['row', 'col'],
                  },
                },
                columnWidths: {
                  type: 'array',
                  description: 'Column width settings',
                  items: {
                    type: 'object',
                    properties: {
                      col: { type: 'number' },
                      width: { type: 'number' },
                    },
                    required: ['col', 'width'],
                  },
                },
                rowHeights: {
                  type: 'array',
                  description: 'Row height settings',
                  items: {
                    type: 'object',
                    properties: {
                      row: { type: 'number' },
                      height: { type: 'number' },
                    },
                    required: ['row', 'height'],
                  },
                },
                mergedCells: {
                  type: 'array',
                  description: 'Merged cell regions',
                  items: {
                    type: 'object',
                    properties: {
                      startRow: { type: 'number' },
                      startCol: { type: 'number' },
                      endRow: { type: 'number' },
                      endCol: { type: 'number' },
                    },
                    required: ['startRow', 'startCol', 'endRow', 'endCol'],
                  },
                },
                freezePane: {
                  type: 'object',
                  description: 'Freeze pane settings. Both row and col default to 1 (no freeze) if omitted.',
                  properties: {
                    row: {
                      type: 'number',
                      description: 'Freeze rows above this row (default: 1, meaning no row freeze)',
                    },
                    col: {
                      type: 'number',
                      description: 'Freeze columns to the left of this column (default: 1, meaning no column freeze)',
                    },
                  },
                },
              },
              required: ['name', 'data'],
            },
          },
        },
        required: ['filename', 'sheets'],
      },
    },
  }),
};

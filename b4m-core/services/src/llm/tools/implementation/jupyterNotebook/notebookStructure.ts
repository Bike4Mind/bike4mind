/**
 * Jupyter Notebook JSON Structure Types
 *
 * Based on nbformat v4.5 specification
 * @see https://nbformat.readthedocs.io/en/latest/format_description.html
 */

export interface NotebookCellOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
  name?: string; // stdout, stderr for stream outputs
  text?: string | string[];
  data?: Record<string, unknown>; // MIME type → data for rich outputs
  execution_count?: number | null;
  ename?: string; // Error name
  evalue?: string; // Error value
  traceback?: string[];
  metadata?: Record<string, unknown>;
}

export interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string | string[];
  metadata: Record<string, unknown>;
  // Code cells only
  outputs?: NotebookCellOutput[];
  execution_count?: number | null;
  // Cell ID (nbformat 4.5+)
  id?: string;
}

export interface NotebookMetadata {
  kernelspec: {
    name: string;
    display_name: string;
    language: string;
  };
  language_info: {
    name: string;
    version?: string;
    mimetype?: string;
    file_extension?: string;
    codemirror_mode?: string | { name: string; version: number };
    pygments_lexer?: string;
    nbconvert_exporter?: string;
  };
  // Optional metadata
  title?: string;
  authors?: Array<{ name: string }>;
  b4m_metadata?: {
    questId?: string;
    sessionId?: string;
    generatedAt?: string;
    analysisDescription?: string;
  };
}

export interface NotebookDocument {
  nbformat: 4;
  nbformat_minor: 5;
  metadata: NotebookMetadata;
  cells: NotebookCell[];
}

/**
 * Kernel configuration for different languages
 */
interface KernelConfig {
  display_name: string;
  language: string;
  language_info: {
    name: string;
    version: string;
    mimetype: string;
    file_extension: string;
    codemirror_mode?: string | { name: string; version: number };
    pygments_lexer?: string;
    nbconvert_exporter?: string;
  };
}

const KERNEL_CONFIGS: Record<string, KernelConfig> = {
  python3: {
    display_name: 'Python 3',
    language: 'python',
    language_info: {
      name: 'python',
      version: '3.10',
      mimetype: 'text/x-python',
      file_extension: '.py',
      codemirror_mode: { name: 'ipython', version: 3 },
      pygments_lexer: 'ipython3',
      nbconvert_exporter: 'python',
    },
  },
  python: {
    display_name: 'Python',
    language: 'python',
    language_info: {
      name: 'python',
      version: '3.10',
      mimetype: 'text/x-python',
      file_extension: '.py',
      codemirror_mode: { name: 'ipython', version: 3 },
      pygments_lexer: 'ipython3',
      nbconvert_exporter: 'python',
    },
  },
  ir: {
    display_name: 'R',
    language: 'R',
    language_info: {
      name: 'R',
      version: '4.3',
      mimetype: 'text/x-r-source',
      file_extension: '.r',
      codemirror_mode: 'r',
    },
  },
  'julia-1.9': {
    display_name: 'Julia 1.9',
    language: 'julia',
    language_info: {
      name: 'julia',
      version: '1.9',
      mimetype: 'application/julia',
      file_extension: '.jl',
    },
  },
  'julia-1.10': {
    display_name: 'Julia 1.10',
    language: 'julia',
    language_info: {
      name: 'julia',
      version: '1.10',
      mimetype: 'application/julia',
      file_extension: '.jl',
    },
  },
};

/**
 * Create an empty notebook with specified kernel
 */
export function createEmptyNotebook(kernelName = 'python3'): NotebookDocument {
  // Get kernel config or fall back to Python 3
  const config = KERNEL_CONFIGS[kernelName] ?? KERNEL_CONFIGS['python3'];

  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        name: kernelName,
        display_name: config.display_name,
        language: config.language,
      },
      language_info: config.language_info,
    },
    cells: [],
  };
}

/**
 * Generate a unique cell ID
 */
function generateCellId(): string {
  // Jupyter uses 8-character alphanumeric IDs
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

/**
 * Normalize source to string array format
 */
function normalizeSource(source: string): string[] {
  // Split by newlines but preserve the newlines in all but the last line
  const lines = source.split('\n');
  return lines.map((line, index) => (index < lines.length - 1 ? line + '\n' : line));
}

/**
 * Add a code cell to the notebook
 */
export function addCodeCell(notebook: NotebookDocument, code: string, metadata: Record<string, unknown> = {}): void {
  notebook.cells.push({
    cell_type: 'code',
    id: generateCellId(),
    source: normalizeSource(code),
    metadata,
    outputs: [],
    execution_count: null,
  });
}

/**
 * Add a markdown cell to the notebook
 */
export function addMarkdownCell(
  notebook: NotebookDocument,
  markdown: string,
  metadata: Record<string, unknown> = {}
): void {
  notebook.cells.push({
    cell_type: 'markdown',
    id: generateCellId(),
    source: normalizeSource(markdown),
    metadata,
  });
}

/**
 * Set the output of a code cell
 */
export function setCellOutput(
  notebook: NotebookDocument,
  cellIndex: number,
  outputs: NotebookCellOutput[],
  executionCount?: number
): void {
  const cell = notebook.cells[cellIndex];
  if (!cell || cell.cell_type !== 'code') {
    throw new Error(`Cell at index ${cellIndex} is not a code cell`);
  }
  cell.outputs = outputs;
  if (executionCount !== undefined) {
    cell.execution_count = executionCount;
  }
}

/**
 * Serialize notebook to JSON string
 */
export function serializeNotebook(notebook: NotebookDocument): string {
  return JSON.stringify(notebook, null, 1);
}

/**
 * Parse a notebook JSON string
 */
export function parseNotebook(json: string): NotebookDocument {
  const parsed = JSON.parse(json);
  if (parsed.nbformat !== 4) {
    throw new Error(`Unsupported notebook format: nbformat ${parsed.nbformat}`);
  }
  return parsed as NotebookDocument;
}

/**
 * Get the source code from a cell as a single string
 */
export function getCellSource(cell: NotebookCell): string {
  if (Array.isArray(cell.source)) {
    return cell.source.join('');
  }
  return cell.source;
}

/**
 * Count the number of code cells in a notebook
 */
export function countCodeCells(notebook: NotebookDocument): number {
  return notebook.cells.filter(c => c.cell_type === 'code').length;
}

import { describe, it, expect } from 'vitest';
import {
  createEmptyNotebook,
  addCodeCell,
  addMarkdownCell,
  setCellOutput,
  serializeNotebook,
  parseNotebook,
  getCellSource,
  countCodeCells,
} from './notebookStructure';

describe('notebookStructure', () => {
  describe('createEmptyNotebook', () => {
    it('should create a valid nbformat 4.5 notebook', () => {
      const notebook = createEmptyNotebook();

      expect(notebook.nbformat).toBe(4);
      expect(notebook.nbformat_minor).toBe(5);
      expect(notebook.cells).toEqual([]);
    });

    it('should default to python3 kernel', () => {
      const notebook = createEmptyNotebook();

      expect(notebook.metadata.kernelspec.name).toBe('python3');
      expect(notebook.metadata.kernelspec.display_name).toBe('Python 3');
      expect(notebook.metadata.kernelspec.language).toBe('python');
      expect(notebook.metadata.language_info.name).toBe('python');
    });

    it('should support R kernel', () => {
      const notebook = createEmptyNotebook('ir');

      expect(notebook.metadata.kernelspec.name).toBe('ir');
      expect(notebook.metadata.kernelspec.display_name).toBe('R');
      expect(notebook.metadata.kernelspec.language).toBe('R');
      expect(notebook.metadata.language_info.name).toBe('R');
      expect(notebook.metadata.language_info.file_extension).toBe('.r');
    });

    it('should support Julia kernel', () => {
      const notebook = createEmptyNotebook('julia-1.10');

      expect(notebook.metadata.kernelspec.name).toBe('julia-1.10');
      expect(notebook.metadata.kernelspec.display_name).toBe('Julia 1.10');
      expect(notebook.metadata.kernelspec.language).toBe('julia');
      expect(notebook.metadata.language_info.file_extension).toBe('.jl');
    });

    it('should fall back to python3 for unknown kernels', () => {
      const notebook = createEmptyNotebook('unknown-kernel');

      expect(notebook.metadata.kernelspec.name).toBe('unknown-kernel');
      expect(notebook.metadata.kernelspec.language).toBe('python');
    });
  });

  describe('addCodeCell', () => {
    it('should add a code cell with unique id', () => {
      const notebook = createEmptyNotebook();
      addCodeCell(notebook, 'print("hello")');

      expect(notebook.cells.length).toBe(1);
      expect(notebook.cells[0].cell_type).toBe('code');
      expect(notebook.cells[0].id).toBeDefined();
      expect(notebook.cells[0].id).toHaveLength(8);
      expect(notebook.cells[0].outputs).toEqual([]);
      expect(notebook.cells[0].execution_count).toBeNull();
    });

    it('should normalize source to array with newlines', () => {
      const notebook = createEmptyNotebook();
      addCodeCell(notebook, 'line1\nline2\nline3');

      const source = notebook.cells[0].source;
      expect(Array.isArray(source)).toBe(true);
      expect(source).toEqual(['line1\n', 'line2\n', 'line3']);
    });

    it('should preserve metadata', () => {
      const notebook = createEmptyNotebook();
      addCodeCell(notebook, 'code', { custom: 'value' });

      expect(notebook.cells[0].metadata).toEqual({ custom: 'value' });
    });
  });

  describe('addMarkdownCell', () => {
    it('should add a markdown cell with unique id', () => {
      const notebook = createEmptyNotebook();
      addMarkdownCell(notebook, '# Title');

      expect(notebook.cells.length).toBe(1);
      expect(notebook.cells[0].cell_type).toBe('markdown');
      expect(notebook.cells[0].id).toBeDefined();
      expect(notebook.cells[0].outputs).toBeUndefined();
    });

    it('should normalize multiline markdown', () => {
      const notebook = createEmptyNotebook();
      addMarkdownCell(notebook, '# Title\n\nParagraph');

      const source = notebook.cells[0].source;
      expect(source).toEqual(['# Title\n', '\n', 'Paragraph']);
    });
  });

  describe('setCellOutput', () => {
    it('should set outputs on a code cell', () => {
      const notebook = createEmptyNotebook();
      addCodeCell(notebook, 'print("test")');

      const outputs = [{ output_type: 'stream' as const, name: 'stdout', text: 'test\n' }];
      setCellOutput(notebook, 0, outputs, 1);

      expect(notebook.cells[0].outputs).toEqual(outputs);
      expect(notebook.cells[0].execution_count).toBe(1);
    });

    it('should throw error for non-code cell', () => {
      const notebook = createEmptyNotebook();
      addMarkdownCell(notebook, '# Title');

      expect(() => {
        setCellOutput(notebook, 0, [], 1);
      }).toThrow('Cell at index 0 is not a code cell');
    });

    it('should throw error for invalid index', () => {
      const notebook = createEmptyNotebook();

      expect(() => {
        setCellOutput(notebook, 99, [], 1);
      }).toThrow('Cell at index 99 is not a code cell');
    });
  });

  describe('serializeNotebook', () => {
    it('should serialize to valid JSON', () => {
      const notebook = createEmptyNotebook();
      addCodeCell(notebook, 'x = 1');

      const json = serializeNotebook(notebook);
      const parsed = JSON.parse(json);

      expect(parsed.nbformat).toBe(4);
      expect(parsed.cells.length).toBe(1);
    });

    it('should use single-space indentation', () => {
      const notebook = createEmptyNotebook();
      const json = serializeNotebook(notebook);

      // Check indentation is single space (JSON.stringify with indent 1)
      expect(json).toContain('\n "nbformat"');
    });
  });

  describe('parseNotebook', () => {
    it('should parse valid notebook JSON', () => {
      const original = createEmptyNotebook();
      addCodeCell(original, 'test');

      const json = serializeNotebook(original);
      const parsed = parseNotebook(json);

      expect(parsed.nbformat).toBe(4);
      expect(parsed.cells.length).toBe(1);
    });

    it('should throw for unsupported nbformat', () => {
      const invalidJson = JSON.stringify({ nbformat: 3 });

      expect(() => parseNotebook(invalidJson)).toThrow('Unsupported notebook format: nbformat 3');
    });

    it('should throw for invalid JSON', () => {
      expect(() => parseNotebook('not json')).toThrow();
    });
  });

  describe('getCellSource', () => {
    it('should join array source to string', () => {
      const notebook = createEmptyNotebook();
      addCodeCell(notebook, 'line1\nline2');

      const source = getCellSource(notebook.cells[0]);
      expect(source).toBe('line1\nline2');
    });

    it('should return string source as-is', () => {
      const cell = {
        cell_type: 'code' as const,
        source: 'single string',
        metadata: {},
      };

      const source = getCellSource(cell);
      expect(source).toBe('single string');
    });
  });

  describe('countCodeCells', () => {
    it('should count only code cells', () => {
      const notebook = createEmptyNotebook();
      addMarkdownCell(notebook, '# Intro');
      addCodeCell(notebook, 'x = 1');
      addCodeCell(notebook, 'y = 2');
      addMarkdownCell(notebook, '# End');

      expect(countCodeCells(notebook)).toBe(2);
    });

    it('should return 0 for empty notebook', () => {
      const notebook = createEmptyNotebook();
      expect(countCodeCells(notebook)).toBe(0);
    });

    it('should return 0 for markdown-only notebook', () => {
      const notebook = createEmptyNotebook();
      addMarkdownCell(notebook, '# Only markdown');

      expect(countCodeCells(notebook)).toBe(0);
    });
  });

  describe('cell id uniqueness', () => {
    it('should generate unique ids for cells', () => {
      const notebook = createEmptyNotebook();
      const ids = new Set<string>();

      for (let i = 0; i < 100; i++) {
        addCodeCell(notebook, `cell ${i}`);
        ids.add(notebook.cells[i].id!);
      }

      expect(ids.size).toBe(100);
    });
  });
});

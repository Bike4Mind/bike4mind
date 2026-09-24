import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  notebooksToExcel,
  notebooksToDocx,
  notebooksToMarkdown,
  downloadBlob,
  type BulkExportData,
} from '../bulkNotebookExport';
import {
  mockBulkExportData,
  mockEmptyBulkExportData,
  mockSingleNotebookExportData,
  toolLoopNotebookData,
} from './fixtures/bulkNotebookExportFixture';

describe('bulkNotebookExport', () => {
  describe('notebooksToMarkdown', () => {
    it('should contain export header', () => {
      const md = notebooksToMarkdown(mockBulkExportData);
      expect(md).toContain('# Notebook Export');
      expect(md).toContain('Exported on');
      expect(md).toContain('Total notebooks: 3');
      expect(md).toContain('Export version: 1.0');
    });

    it('should contain table of contents', () => {
      const md = notebooksToMarkdown(mockBulkExportData);
      expect(md).toContain('## Table of Contents');
      expect(md).toContain('1. Project Planning Session');
      expect(md).toContain('2. Code Review Session');
      expect(md).toContain('3. Empty Notebook');
    });

    it('should contain all notebook names as headings', () => {
      const md = notebooksToMarkdown(mockBulkExportData);
      expect(md).toContain('# Project Planning Session');
      expect(md).toContain('# Code Review Session');
      expect(md).toContain('# Empty Notebook');
    });

    it('should contain notebook metadata', () => {
      const md = notebooksToMarkdown(mockBulkExportData);
      expect(md).toContain('Created:');
      expect(md).toContain('Updated:');
    });

    it('should contain tags when present', () => {
      const md = notebooksToMarkdown(mockBulkExportData);
      expect(md).toContain('Tags: planning, architecture');
    });

    it('should contain summary when present', () => {
      const md = notebooksToMarkdown(mockBulkExportData);
      expect(md).toContain('## Summary');
      expect(md).toContain('Discussion about project architecture and timeline');
    });

    it('should contain conversation sections', () => {
      const md = notebooksToMarkdown(mockBulkExportData);
      expect(md).toContain('## Conversation');
      expect(md).toContain('**User**:');
      expect(md).toContain('**AI**:');
      expect(md).toContain('**System**:');
    });

    it('should contain message content', () => {
      const md = notebooksToMarkdown(mockBulkExportData);
      expect(md).toContain('Let me outline the project requirements');
      expect(md).toContain('REST API with authentication');
      expect(md).toContain('JWT-based auth');
    });

    it('should handle empty notebooks list', () => {
      const md = notebooksToMarkdown(mockEmptyBulkExportData);
      expect(md).toContain('# Notebook Export');
      expect(md).toContain('Total notebooks: 0');
    });

    it('should handle notebooks with empty chat history', () => {
      const md = notebooksToMarkdown(mockBulkExportData);
      expect(md).toContain('# Empty Notebook');
      // Should still have conversation section header
      expect(md).toContain('## Conversation');
    });

    /**
     * A tool-using turn persists several reply slots and some hold only a thinking block, so
     * the per-slot walk this replaced wrote an empty `**AI**:` heading per think-only slot and
     * pasted the model's reasoning into the export.
     */
    it('writes one AI entry per tool-loop turn and no thinking text', () => {
      const toolLoop = toolLoopNotebookData();
      const md = notebooksToMarkdown(toolLoop);

      expect(md).toContain('**AI**:\n\nPARTIAL FINAL');
      expect(md.match(/\*\*AI\*\*:/g)).toHaveLength(1);
      expect(md).not.toContain('reasoning');
      expect(md).not.toContain('<think>');
    });

    /**
     * Without the reply's citables, stripSearchResultCardFences can't tell a real place from an
     * invented one and drops the whole map fence - the safe default, but it must actually receive
     * them (bulkNotebookExport used to strip with no citables at all, so a b4m_map fence never
     * resolved to a place list here even when the reply carried a real one).
     */
    it('resolves a b4m_map fence using the message promptMeta citables', () => {
      const data: BulkExportData = {
        exportVersion: '1.0',
        exportedAt: '2024-01-15T12:00:00Z',
        notebooks: [
          {
            id: 'notebook-map',
            name: 'Map Session',
            firstCreated: '2024-01-10T09:00:00Z',
            lastUpdated: '2024-01-10T09:10:00Z',
            chatHistory: [
              {
                id: 'msg-map',
                timestamp: '2024-01-10T09:00:00Z',
                type: 'user',
                prompt: 'restaurants near my hotel',
                replies: ['Here are some options.\n\n```b4m_map\n{"places":[{"id":"place-1","name":"Barr"}]}\n```\n'],
                promptMeta: {
                  citables: [
                    {
                      id: 'place:place-1',
                      type: 'web_url',
                      title: 'Barr',
                      metadata: { place: { id: 'place-1', name: 'Barr', lat: 55.67, lng: 12.57 } },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const md = notebooksToMarkdown(data);
      expect(md).toContain('Barr');
      expect(md).toContain('Open in Google Maps');
      expect(md).not.toContain('b4m_map');
    });
  });

  describe('notebooksToExcel', () => {
    it('should generate a valid xlsx blob', async () => {
      const blob = await notebooksToExcel(mockBulkExportData);
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    });

    it('should generate a blob with non-zero size', async () => {
      const blob = await notebooksToExcel(mockBulkExportData);
      expect(blob.size).toBeGreaterThan(0);
    });

    it('should handle empty notebooks list', async () => {
      const blob = await notebooksToExcel(mockEmptyBulkExportData);
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });

    it('should handle single notebook', async () => {
      const blob = await notebooksToExcel(mockSingleNotebookExportData);
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });
  });

  describe('notebooksToDocx', () => {
    it('should generate a valid docx blob', async () => {
      const blob = await notebooksToDocx(mockBulkExportData);
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    });

    it('should generate a blob with non-zero size', async () => {
      const blob = await notebooksToDocx(mockBulkExportData);
      expect(blob.size).toBeGreaterThan(0);
    });

    it('should handle empty notebooks list', async () => {
      const blob = await notebooksToDocx(mockEmptyBulkExportData);
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });

    it('should handle single notebook', async () => {
      const blob = await notebooksToDocx(mockSingleNotebookExportData);
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });
  });

  describe('downloadBlob', () => {
    let createObjectURLMock: ReturnType<typeof vi.fn>;
    let revokeObjectURLMock: ReturnType<typeof vi.fn>;
    let appendChildMock: ReturnType<typeof vi.fn>;
    let removeChildMock: ReturnType<typeof vi.fn>;
    let clickMock: ReturnType<typeof vi.fn>;
    let mockLink: { href: string; download: string; click: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      createObjectURLMock = vi.fn().mockReturnValue('blob:mock-url');
      revokeObjectURLMock = vi.fn();
      clickMock = vi.fn();
      appendChildMock = vi.fn();
      removeChildMock = vi.fn();

      mockLink = {
        href: '',
        download: '',
        click: clickMock,
      };

      vi.stubGlobal('URL', {
        createObjectURL: createObjectURLMock,
        revokeObjectURL: revokeObjectURLMock,
      });

      vi.spyOn(document, 'createElement').mockReturnValue(mockLink as unknown as HTMLAnchorElement);
      vi.spyOn(document.body, 'appendChild').mockImplementation(appendChildMock);
      vi.spyOn(document.body, 'removeChild').mockImplementation(removeChildMock);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should create object URL from blob', () => {
      const blob = new Blob(['test'], { type: 'text/plain' });
      downloadBlob(blob, 'test.txt');
      expect(createObjectURLMock).toHaveBeenCalledWith(blob);
    });

    it('should set correct filename on link', () => {
      const blob = new Blob(['test'], { type: 'text/plain' });
      downloadBlob(blob, 'my-export.xlsx');
      expect(mockLink.download).toBe('my-export.xlsx');
    });

    it('should trigger click to download', () => {
      const blob = new Blob(['test'], { type: 'text/plain' });
      downloadBlob(blob, 'test.txt');
      expect(clickMock).toHaveBeenCalled();
    });

    it('should revoke object URL after download', () => {
      const blob = new Blob(['test'], { type: 'text/plain' });
      downloadBlob(blob, 'test.txt');
      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-url');
    });

    it('should append and remove link from document body', () => {
      const blob = new Blob(['test'], { type: 'text/plain' });
      downloadBlob(blob, 'test.txt');
      expect(appendChildMock).toHaveBeenCalled();
      expect(removeChildMock).toHaveBeenCalled();
    });
  });
});

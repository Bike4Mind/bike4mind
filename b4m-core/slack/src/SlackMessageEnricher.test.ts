/**
 * Tests for SlackMessageEnricher
 * Tests table extraction from Slack Web API format to markdown
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackMessageEnricher } from './SlackMessageEnricher';

// Mock SlackClient
const mockSlackClient = {
  fetchSingleMessage: vi.fn(),
} as any;

// Mock Logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('SlackMessageEnricher', () => {
  let enricher: SlackMessageEnricher;

  beforeEach(() => {
    vi.clearAllMocks();
    enricher = new SlackMessageEnricher(mockSlackClient, mockLogger as any);
  });

  describe('tableBlockToMarkdown', () => {
    it('should convert a simple table with raw_text cells to markdown', () => {
      const tableBlock = {
        type: 'table' as const,
        rows: [
          [
            { type: 'raw_text' as const, text: 'Name' },
            { type: 'raw_text' as const, text: 'Age' },
          ],
          [
            { type: 'raw_text' as const, text: 'Alice' },
            { type: 'raw_text' as const, text: '30' },
          ],
          [
            { type: 'raw_text' as const, text: 'Bob' },
            { type: 'raw_text' as const, text: '25' },
          ],
        ],
      };

      const result = enricher.tableBlockToMarkdown(tableBlock);

      expect(result).toBe('| Name | Age |\n' + '| --- | --- |\n' + '| Alice | 30 |\n' + '| Bob | 25 |');
    });

    it('should convert a table with rich_text cells to markdown', () => {
      const tableBlock = {
        type: 'table' as const,
        rows: [
          [
            {
              type: 'rich_text' as const,
              elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Header1' }] }],
            },
            {
              type: 'rich_text' as const,
              elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Header2' }] }],
            },
          ],
          [
            {
              type: 'rich_text' as const,
              elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Value1' }] }],
            },
            {
              type: 'rich_text' as const,
              elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Value2' }] }],
            },
          ],
        ],
      };

      const result = enricher.tableBlockToMarkdown(tableBlock);

      expect(result).toBe('| Header1 | Header2 |\n' + '| --- | --- |\n' + '| Value1 | Value2 |');
    });

    it('should handle null cells', () => {
      const tableBlock = {
        type: 'table' as const,
        rows: [
          [{ type: 'raw_text' as const, text: 'Name' }, null],
          [{ type: 'raw_text' as const, text: 'Alice' }, null],
        ],
      };

      const result = enricher.tableBlockToMarkdown(tableBlock);

      expect(result).toBe('| Name |  |\n' + '| --- | --- |\n' + '| Alice |  |');
    });

    it('should skip completely empty rows', () => {
      const tableBlock = {
        type: 'table' as const,
        rows: [
          [
            { type: 'raw_text' as const, text: 'Name' },
            { type: 'raw_text' as const, text: 'Age' },
          ],
          [null, null], // Empty row should be skipped
          [
            { type: 'raw_text' as const, text: 'Alice' },
            { type: 'raw_text' as const, text: '30' },
          ],
        ],
      };

      const result = enricher.tableBlockToMarkdown(tableBlock);

      expect(result).toBe('| Name | Age |\n' + '| --- | --- |\n' + '| Alice | 30 |');
    });

    it('should return empty string for empty table', () => {
      const tableBlock = {
        type: 'table' as const,
        rows: [],
      };

      const result = enricher.tableBlockToMarkdown(tableBlock);

      expect(result).toBe('');
    });

    it('should return empty string for undefined rows', () => {
      const tableBlock = {
        type: 'table' as const,
        rows: undefined as any,
      };

      const result = enricher.tableBlockToMarkdown(tableBlock);

      expect(result).toBe('');
    });
  });

  describe('extractTablesAsMarkdown', () => {
    it('should extract tables from message attachments', () => {
      const message = {
        ts: '123456.789',
        attachments: [
          {
            id: 1,
            blocks: [
              {
                type: 'table',
                rows: [
                  [
                    { type: 'raw_text' as const, text: 'Col1' },
                    { type: 'raw_text' as const, text: 'Col2' },
                  ],
                  [
                    { type: 'raw_text' as const, text: 'A' },
                    { type: 'raw_text' as const, text: 'B' },
                  ],
                ],
              },
            ],
          },
        ],
      };

      const result = enricher.extractTablesAsMarkdown(message);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe('| Col1 | Col2 |\n' + '| --- | --- |\n' + '| A | B |');
    });

    it('should extract multiple tables from multiple attachments', () => {
      const message = {
        ts: '123456.789',
        attachments: [
          {
            id: 1,
            blocks: [
              {
                type: 'table',
                rows: [[{ type: 'raw_text' as const, text: 'Table1' }], [{ type: 'raw_text' as const, text: 'Data1' }]],
              },
            ],
          },
          {
            id: 2,
            blocks: [
              {
                type: 'table',
                rows: [[{ type: 'raw_text' as const, text: 'Table2' }], [{ type: 'raw_text' as const, text: 'Data2' }]],
              },
            ],
          },
        ],
      };

      const result = enricher.extractTablesAsMarkdown(message);

      expect(result).toHaveLength(2);
    });

    it('should return empty array when no attachments', () => {
      const message = {
        ts: '123456.789',
        attachments: undefined,
      };

      const result = enricher.extractTablesAsMarkdown(message);

      expect(result).toEqual([]);
    });

    it('should ignore non-table blocks', () => {
      const message = {
        ts: '123456.789',
        attachments: [
          {
            id: 1,
            blocks: [{ type: 'section', text: { type: 'plain_text', text: 'Hello' } }, { type: 'divider' }],
          },
        ],
      };

      const result = enricher.extractTablesAsMarkdown(message);

      expect(result).toEqual([]);
    });

    it('should handle attachments without blocks', () => {
      const message = {
        ts: '123456.789',
        attachments: [
          {
            id: 1,
            fallback: 'Some fallback text',
          },
        ],
      };

      const result = enricher.extractTablesAsMarkdown(message);

      expect(result).toEqual([]);
    });
  });

  describe('enrichMessageText', () => {
    it('should enrich message with table data', async () => {
      const tableMessage = {
        ts: '123456.789',
        attachments: [
          {
            id: 1,
            blocks: [
              {
                type: 'table',
                rows: [
                  [
                    { type: 'raw_text' as const, text: 'Name' },
                    { type: 'raw_text' as const, text: 'Status' },
                  ],
                  [
                    { type: 'raw_text' as const, text: 'Task1' },
                    { type: 'raw_text' as const, text: 'Done' },
                  ],
                ],
              },
            ],
          },
        ],
      };

      mockSlackClient.fetchSingleMessage.mockResolvedValue(tableMessage);

      const result = await enricher.enrichMessageText('C123', '123456.789', 'Create a page with this table:');

      expect(result.wasEnriched).toBe(true);
      expect(result.tableCount).toBe(1);
      expect(result.text).toContain('Create a page with this table:');
      expect(result.text).toContain('| Name | Status |');
      expect(result.text).toContain('| Task1 | Done |');
    });

    it('should return original text when no tables found', async () => {
      mockSlackClient.fetchSingleMessage.mockResolvedValue({
        ts: '123456.789',
        text: 'Just a regular message',
      });

      const result = await enricher.enrichMessageText('C123', '123456.789', 'Original text');

      expect(result.wasEnriched).toBe(false);
      expect(result.tableCount).toBe(0);
      expect(result.text).toBe('Original text');
    });

    it('should return original text when fetch fails', async () => {
      mockSlackClient.fetchSingleMessage.mockResolvedValue(null);

      const result = await enricher.enrichMessageText('C123', '123456.789', 'Original text');

      expect(result.wasEnriched).toBe(false);
      expect(result.tableCount).toBe(0);
      expect(result.text).toBe('Original text');
      expect(mockLogger.warn).toHaveBeenCalledWith('[ENRICHER] Failed to fetch full message from Slack');
    });
  });
});

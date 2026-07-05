import { Logger } from '@bike4mind/observability';
import { SlackClient } from './SlackClient';

/**
 * Slack table cell types from Web API
 */
interface SlackTableCell {
  type: 'rich_text' | 'raw_text';
  text?: string;
  block_id?: string;
  elements?: Array<{
    type: string;
    elements?: Array<{
      type: string;
      text?: string;
      style?: { bold?: boolean };
    }>;
  }>;
}

/**
 * Slack table block structure from Web API
 */
interface SlackTableBlock {
  type: 'table';
  block_id?: string;
  rows: (SlackTableCell | null)[][];
  column_settings?: unknown[];
}

/**
 * Slack attachment with blocks
 */
interface SlackAttachmentWithBlocks {
  id?: number;
  blocks?: (SlackTableBlock | { type: string })[];
  fallback?: string;
}

/**
 * Full message structure from Web API
 */
interface SlackFullMessage {
  text?: string;
  ts: string;
  user?: string;
  attachments?: SlackAttachmentWithBlocks[];
  blocks?: unknown[];
  files?: unknown[];
}

/**
 * SlackMessageEnricher handles fetching and parsing full message content
 * from Slack's Web API when the Events API truncates data (like tables)
 *
 * Uses SlackClient for API calls to benefit from SDK features
 * (retries, rate limiting, error handling)
 */
export class SlackMessageEnricher {
  private slackClient: SlackClient;
  private logger?: Logger;

  constructor(slackClient: SlackClient, logger?: Logger) {
    this.slackClient = slackClient;
    this.logger = logger;
  }

  /**
   * Extract text from a table cell
   */
  private extractCellText(cell: SlackTableCell | null): string {
    if (!cell) return '';

    // raw_text type has direct text
    if (cell.type === 'raw_text' && cell.text) {
      return cell.text;
    }

    // rich_text type has nested elements
    if (cell.type === 'rich_text' && cell.elements) {
      const texts: string[] = [];
      for (const element of cell.elements) {
        if (element.elements) {
          for (const inner of element.elements) {
            if (inner.text) {
              texts.push(inner.text);
            }
          }
        }
      }
      return texts.join('');
    }

    return '';
  }

  /**
   * Convert Slack table block to markdown table format
   */
  tableBlockToMarkdown(tableBlock: SlackTableBlock): string {
    const rows = tableBlock.rows;
    if (!rows || rows.length === 0) return '';

    const markdownRows: string[] = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      // Extract cell text and escape pipes/newlines to prevent markdown injection
      const cells = row.map(cell => this.extractCellText(cell).replace(/\|/g, '\\|').replace(/\n/g, ' '));

      // Skip completely empty rows
      if (cells.every(c => !c)) continue;

      // Create markdown row
      const markdownRow = '| ' + cells.join(' | ') + ' |';
      markdownRows.push(markdownRow);

      // Add separator after header row (first non-empty row)
      if (markdownRows.length === 1) {
        const separator = '| ' + cells.map(() => '---').join(' | ') + ' |';
        markdownRows.push(separator);
      }
    }

    return markdownRows.join('\n');
  }

  /**
   * Extract all tables from message attachments and convert to markdown
   */
  extractTablesAsMarkdown(message: SlackFullMessage): string[] {
    const tables: string[] = [];

    if (!message.attachments) return tables;

    for (const attachment of message.attachments) {
      if (!attachment.blocks) continue;

      for (const block of attachment.blocks) {
        if (block.type === 'table') {
          const tableBlock = block as SlackTableBlock;
          const markdown = this.tableBlockToMarkdown(tableBlock);
          if (markdown) {
            tables.push(markdown);
          }
        }
      }
    }

    return tables;
  }

  /**
   * Enrich message text with full table content from Web API
   * Returns the original text plus any extracted tables
   *
   * Always fetches full message to check for table attachments because
   * Slack's Events API doesn't include rich table data pasted from spreadsheets.
   */
  async enrichMessageText(
    channel: string,
    ts: string,
    originalText: string
  ): Promise<{ text: string; wasEnriched: boolean; tableCount: number }> {
    this.logger?.debug('[ENRICHER] Fetching full message to check for tables', {
      channel,
      ts,
      textLength: originalText.length,
    });

    // Fetch full message using SlackClient
    const fullMessage = await this.slackClient.fetchSingleMessage(channel, ts);
    if (!fullMessage) {
      this.logger?.warn('[ENRICHER] Failed to fetch full message from Slack');
      return { text: originalText, wasEnriched: false, tableCount: 0 };
    }

    // Extract tables
    const tables = this.extractTablesAsMarkdown(fullMessage as unknown as SlackFullMessage);

    if (tables.length === 0) {
      this.logger?.info('[ENRICHER] No tables found in full message');
      return { text: originalText, wasEnriched: false, tableCount: 0 };
    }

    this.logger?.info('[ENRICHER] Successfully extracted tables from message', {
      tableCount: tables.length,
      totalRows: tables.reduce((acc, t) => acc + t.split('\n').length, 0),
    });

    // Combine original text with extracted tables
    const enrichedText = originalText + '\n\n' + tables.join('\n\n');

    return {
      text: enrichedText,
      wasEnriched: true,
      tableCount: tables.length,
    };
  }
}

import { Logger } from '@bike4mind/observability';
/**
 * AST-based Markdown to Slack Block Kit converter.
 *
 * Uses unified/remark (industry-standard Markdown AST) to parse LLM output
 * and convert Markdown tables into bullet lists that Slack can render.
 *
 * Why: Slack's `type: 'markdown'` block renders standard Markdown (headers,
 * bold, links, lists, code) but does NOT support tables - they appear as raw
 * pipe characters. This module replaces table nodes in the AST with list
 * nodes so every table renders cleanly in Slack.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import type { Root, Table, TableRow, TableCell, PhrasingContent, List, ListItem, Paragraph } from 'mdast';

/** Result of processing Markdown for Slack. */
export interface SlackFormattedResult {
  /** Markdown text with tables converted to lists. */
  text: string;
}

/**
 * Build a paragraph's children array by interleaving table cell AST children
 * with ` | ` text separators. Preserves link nodes so remark-stringify
 * serializes them as proper `[text](url)` instead of escaping characters.
 */
function interleaveCells(cells: TableCell[]): PhrasingContent[] {
  const result: PhrasingContent[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (i > 0) result.push({ type: 'text', value: ' | ' });
    result.push(...(cells[i].children as PhrasingContent[]));
  }
  return result;
}

/**
 * Convert an mdast Table node into a List node.
 *
 * Preserves AST children (including link nodes) so remark-stringify handles
 * them natively - no manual text extraction that would strip URLs.
 *
 * - 2-column tables -> `**Key**: Value` bullet items (common for LLM structured output)
 * - Wider tables -> `Col1 | Col2 | Col3` bullet items with header row as first item
 */
function tableToList(table: Table): List {
  const rows = table.children as TableRow[];
  if (rows.length === 0) {
    return { type: 'list', ordered: false, spread: false, children: [] };
  }

  const headerRow = rows[0];
  const dataRows = rows.slice(1);
  const columnCount = headerRow.children.length;

  const items: ListItem[] = [];

  if (columnCount === 2) {
    // 2-column: render as **Key**: Value, preserving AST children for both
    for (const row of dataRows) {
      const cells = row.children as TableCell[];
      const keyChildren = (cells[0]?.children as PhrasingContent[]) ?? [];
      const valueChildren = (cells[1]?.children as PhrasingContent[]) ?? [];
      const paragraph: Paragraph = {
        type: 'paragraph',
        children: [{ type: 'strong', children: [...keyChildren] }, { type: 'text', value: ': ' }, ...valueChildren],
      };
      items.push({ type: 'listItem', spread: false, children: [paragraph] });
    }
  } else {
    // 3+ columns: header row with emphasis, then pipe-separated data rows
    const headerChildren: PhrasingContent[] = [];
    for (let i = 0; i < headerRow.children.length; i++) {
      if (i > 0) headerChildren.push({ type: 'text', value: ' | ' });
      headerChildren.push({
        type: 'emphasis',
        children: [...((headerRow.children[i] as TableCell).children as PhrasingContent[])],
      });
    }
    items.push({
      type: 'listItem',
      spread: false,
      children: [{ type: 'paragraph', children: headerChildren }],
    });
    for (const row of dataRows) {
      items.push({
        type: 'listItem',
        spread: false,
        children: [{ type: 'paragraph', children: interleaveCells(row.children as TableCell[]) }],
      });
    }
  }

  return { type: 'list', ordered: false, spread: false, children: items };
}

/**
 * Process Markdown text for Slack delivery.
 *
 * 1. Parses the Markdown into an AST (unified + remark-parse + remark-gfm).
 * 2. Replaces all `table` nodes with `list` nodes (preserving link nodes).
 * 3. Stringifies the AST back to Markdown.
 * 4. Converts markdown links `[text](url)` to Slack links `<url|text>`.
 *
 * Returns clean Markdown with tables converted to lists and links in Slack format.
 */
export function processMarkdownForSlack(markdown: string): SlackFormattedResult {
  try {
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify);

    const tree = processor.parse(markdown) as Root;

    // Replace table nodes with list nodes in-place
    tree.children = tree.children.map(node => {
      if (node.type === 'table') {
        return tableToList(node as Table);
      }
      return node;
    });

    let text = processor.stringify(tree);

    // Convert markdown links [text](url) to Slack links <url|text>.
    // Link nodes in the AST are serialized cleanly by remark-stringify (no escaping).
    // Known limitation: URLs containing parentheses (e.g., Wikipedia) will truncate
    // at the first ')'. GitHub/Jira URLs never contain parentheses so this is safe.
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

    return { text };
  } catch (error) {
    Logger.globalInstance.error('[processMarkdownForSlack] Remark parsing failed, returning raw markdown:', error);
    return { text: markdown };
  }
}

import { describe, it, expect } from 'vitest';
import { wikiMarkupToAdf, containsWikiTable } from '../api';

describe('containsWikiTable', () => {
  it('should detect header row format (||Header||)', () => {
    expect(containsWikiTable('||Name||Age||')).toBe(true);
    expect(containsWikiTable('Some text\n||Col1||Col2||\nMore text')).toBe(true);
  });

  it('should detect data row format (|Value|)', () => {
    expect(containsWikiTable('|Alice|30|')).toBe(true);
    expect(containsWikiTable('Some text\n|Data1|Data2|\nMore text')).toBe(true);
  });

  it('should not detect regular text with pipes', () => {
    // Single pipes in middle of line are not wiki tables
    expect(containsWikiTable('This | is not | a table')).toBe(false);
    expect(containsWikiTable('Use command | grep pattern')).toBe(false);
  });

  it('should not detect empty text', () => {
    expect(containsWikiTable('')).toBe(false);
  });

  it('should detect tables in multiline text', () => {
    const text = `
Here is a table:
||Ticket||Status||
|TBI-001|Open|
|TBI-002|Closed|
    `;
    expect(containsWikiTable(text)).toBe(true);
  });
});

describe('wikiMarkupToAdf', () => {
  it('should convert a simple wiki table to ADF', () => {
    const wikiMarkup = `||Name||Age||
|Alice|30|
|Bob|25|`;

    const result = wikiMarkupToAdf(wikiMarkup);

    expect(result.type).toBe('doc');
    expect(result.version).toBe(1);
    expect(result.content).toHaveLength(1);

    const table = result.content[0];
    expect(table.type).toBe('table');

    if (table.type === 'table') {
      expect(table.content).toHaveLength(3); // 1 header row + 2 data rows

      // Check header row
      const headerRow = table.content[0];
      expect(headerRow.content).toHaveLength(2);
      expect(headerRow.content[0].type).toBe('tableHeader');
      expect(headerRow.content[1].type).toBe('tableHeader');

      // Check data rows
      const dataRow1 = table.content[1];
      expect(dataRow1.content[0].type).toBe('tableCell');
      expect(dataRow1.content[1].type).toBe('tableCell');
    }
  });

  it('should handle text before and after table', () => {
    const wikiMarkup = `Introduction paragraph.

||Header1||Header2||
|Value1|Value2|

Conclusion paragraph.`;

    const result = wikiMarkupToAdf(wikiMarkup);

    expect(result.content).toHaveLength(3);
    expect(result.content[0].type).toBe('paragraph');
    expect(result.content[1].type).toBe('table');
    expect(result.content[2].type).toBe('paragraph');
  });

  it('should handle empty cells', () => {
    const wikiMarkup = `||Name||Notes||
|Alice||
||Bob|`;

    const result = wikiMarkupToAdf(wikiMarkup);

    const table = result.content[0];
    if (table.type === 'table') {
      const dataRow = table.content[1];
      // Empty cell should have a space
      const emptyCell = dataRow.content[1];
      expect(emptyCell.content[0].content[0].text).toBe(' ');
    }
  });

  it('should handle plain text without tables', () => {
    const plainText = `This is just some plain text.
No tables here.
Just paragraphs.`;

    const result = wikiMarkupToAdf(plainText);

    expect(result.content).toHaveLength(3);
    result.content.forEach(block => {
      expect(block.type).toBe('paragraph');
    });
  });

  it('should handle empty input', () => {
    const result = wikiMarkupToAdf('');

    expect(result.type).toBe('doc');
    expect(result.version).toBe(1);
    // Should have at least one paragraph to be valid ADF
    expect(result.content.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle multiple tables', () => {
    const wikiMarkup = `First table:
||A||B||
|1|2|

Second table:
||X||Y||
|3|4|`;

    const result = wikiMarkupToAdf(wikiMarkup);

    const tables = result.content.filter(block => block.type === 'table');
    expect(tables).toHaveLength(2);
  });

  it('should preserve cell content with special characters', () => {
    const wikiMarkup = `||Description||
|Test <html> & "quotes"|`;

    const result = wikiMarkupToAdf(wikiMarkup);

    const table = result.content[0];
    if (table.type === 'table') {
      const dataRow = table.content[1];
      const cellText = dataRow.content[0].content[0].content[0].text;
      expect(cellText).toBe('Test <html> & "quotes"');
    }
  });

  it('should handle whitespace in cells', () => {
    const wikiMarkup = `||Name||
|  Alice  |`;

    const result = wikiMarkupToAdf(wikiMarkup);

    const table = result.content[0];
    if (table.type === 'table') {
      const dataRow = table.content[1];
      const cellText = dataRow.content[0].content[0].content[0].text;
      // Should be trimmed
      expect(cellText).toBe('Alice');
    }
  });

  it('should set correct table attributes', () => {
    const wikiMarkup = `||Col||
|Val|`;

    const result = wikiMarkupToAdf(wikiMarkup);

    const table = result.content[0];
    if (table.type === 'table') {
      expect(table.attrs.isNumberColumnEnabled).toBe(false);
      expect(table.attrs.layout).toBe('default');
    }
  });
});

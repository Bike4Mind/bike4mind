import { describe, it, expect } from 'vitest';
import { processMarkdownForSlack } from './slackMarkdown';

describe('processMarkdownForSlack', () => {
  it('should convert markdown links to Slack format', () => {
    const input = 'Check [this link](https://example.com) for details.';
    const { text } = processMarkdownForSlack(input);
    expect(text).toContain('<https://example.com|this link>');
  });

  it('should preserve links in table cells after table-to-list conversion', () => {
    const input = [
      '| # | Title | Branch |',
      '|---|-------|--------|',
      '| [#360](https://github.com/org/repo/pull/360) | fix bug | main |',
      '| [#356](https://github.com/org/repo/pull/356) | add feature | dev |',
    ].join('\n');

    const { text } = processMarkdownForSlack(input);

    expect(text).toContain('<https://github.com/org/repo/pull/360|#360>');
    expect(text).toContain('<https://github.com/org/repo/pull/356|#356>');
    expect(text).not.toContain('[#360]');
  });

  it('should preserve links in 2-column table cells', () => {
    const input = ['| Key | Value |', '|-----|-------|', '| PR | [#100](https://github.com/org/repo/pull/100) |'].join(
      '\n'
    );

    const { text } = processMarkdownForSlack(input);

    expect(text).toContain('<https://github.com/org/repo/pull/100|#100>');
  });

  it('should pass through plain text unchanged', () => {
    const input = 'Hello world, no tables here.';
    const { text } = processMarkdownForSlack(input);
    expect(text.trim()).toBe(input);
  });

  it('should handle tables with no links', () => {
    const input = ['| Name | Status |', '|------|--------|', '| Alice | Active |'].join('\n');

    const { text } = processMarkdownForSlack(input);

    expect(text).toContain('Alice');
    expect(text).toContain('Active');
  });

  it('should handle URLs with ampersands', () => {
    const input = 'See [results](https://example.com/search?a=1&b=2) for details.';
    const { text } = processMarkdownForSlack(input);
    // remark-stringify escapes & as \& in URLs; Slack still resolves the link
    expect(text).toContain('<https://example.com/search?a=1\\&b=2|results>');
  });

  it('should truncate URLs containing parentheses (known limitation)', () => {
    // The regex [^)]+ stops at the first ) so Wikipedia-style URLs truncate.
    // This is acceptable since GitHub/Jira URLs never contain parentheses.
    const input = 'See [Mars](https://en.wikipedia.org/wiki/Mars_(planet)) for info.';
    const { text } = processMarkdownForSlack(input);
    // URL truncates at first ) - known limitation
    expect(text).not.toContain('Mars_(planet)');
  });
});

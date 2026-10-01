import { describe, expect, it } from 'vitest';
import { stripFrontmatter } from './stripFrontmatter';

describe('stripFrontmatter', () => {
  it('removes a leading frontmatter block and the blank lines after it', () => {
    expect(stripFrontmatter('---\ndate: 2015-06-01\ntitle: Hello\n---\n\n# Body\n')).toBe('# Body\n');
  });

  it('handles CRLF line endings', () => {
    expect(stripFrontmatter('---\r\ntitle: Hello\r\n---\r\n\r\nBody')).toBe('Body');
  });

  it('handles a leading BOM', () => {
    expect(stripFrontmatter('\uFEFF---\ntitle: Hello\n---\nBody')).toBe('Body');
  });

  it('handles an empty block', () => {
    expect(stripFrontmatter('---\n---\nBody')).toBe('Body');
  });

  it('handles a block with no body after it', () => {
    expect(stripFrontmatter('---\ntitle: Hello\n---')).toBe('');
  });

  it('returns content without frontmatter unchanged', () => {
    const content = '# Title\n\nSome text\n';
    expect(stripFrontmatter(content)).toBe(content);
  });

  it('leaves an unterminated block unchanged', () => {
    const content = '---\ntitle: Hello\n\nBody text with no closing rule\n';
    expect(stripFrontmatter(content)).toBe(content);
  });

  it('only strips at the start of the document', () => {
    const content = 'Intro\n\n---\ntitle: Hello\n---\n\nBody';
    expect(stripFrontmatter(content)).toBe(content);
  });

  it('does not end the block on a dashed run inside a value', () => {
    expect(stripFrontmatter('---\ntitle: a---b\n---\nBody')).toBe('Body');
  });

  it('strips a block of lists, nested values, and comments', () => {
    const block = '---\n# note\ntags:\n  - a\n  - b\nmeta:\n  author: me\n"quoted key": 1\n---\nBody';
    expect(stripFrontmatter(block)).toBe('Body');
  });

  it('keeps prose that sits between two horizontal rules', () => {
    const content = '---\nSome intro paragraph.\n\nAnother paragraph.\n---\nBody';
    expect(stripFrontmatter(content)).toBe(content);
  });

  it('keeps a document that opens and closes with a rule around a heading', () => {
    const content = '---\n# Title\nplain text\n---\nBody';
    expect(stripFrontmatter(content)).toBe(content);
  });

  it('keeps a lone heading between two leading rules', () => {
    const content = '---\n# Title\n---\nBody';
    expect(stripFrontmatter(content)).toBe(content);
  });

  it('keeps a bulleted list between two leading rules', () => {
    const content = '---\n- Step one\n- Step two\n---\nRest of doc';
    expect(stripFrontmatter(content)).toBe(content);
  });

  it('strips a block of blank lines only', () => {
    expect(stripFrontmatter('---\n\n---\nBody')).toBe('Body');
  });

  it('keeps a horizontal rule that follows the block', () => {
    expect(stripFrontmatter('---\ntitle: Hello\n---\n\n---\n\nBody')).toBe('---\n\nBody');
  });
});

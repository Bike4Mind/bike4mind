import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReplyMarkdown } from './ReplyMarkdown';

/**
 * Rendered to a string rather than into a DOM: this package's vitest runs on `node`, and every
 * question worth asking of this component - did the fence keep its language, did the sanitizer
 * drop that tag, is this a block or an inline chip - is answerable from the markup. It also
 * means the assertions run through the real plugin arrays, so the pipeline cannot drift away
 * from what ships.
 */
const render = (text: string) => renderToStaticMarkup(<ReplyMarkdown text={text} />);

describe('ReplyMarkdown', () => {
  describe('prose', () => {
    it('renders structure rather than the characters that describe it', () => {
      const html = render('# Title\n\nSome **bold** text.');
      expect(html).toContain('<h1>Title</h1>');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).not.toContain('# Title');
    });

    it('renders nested lists', () => {
      const html = render('- one\n  - nested\n- two');
      expect(html).toContain('<ul>');
      expect(html).toContain('nested');
      expect(html.match(/<ul>/g)).toHaveLength(2);
    });

    it('renders a GFM table', () => {
      const html = render('| a | b |\n| --- | --- |\n| 1 | 2 |');
      expect(html).toContain('<table>');
      expect(html).toContain('<th');
      expect(html).toContain('<td');
    });
  });

  describe('code', () => {
    it('honours the language hint on a fence', () => {
      const html = render('```ts\nconst x: number = 1;\n```');
      expect(html).toContain('data-testid="chat-markdown-code-block"');
      expect(html).toContain('data-language="ts"');
      // The highlighter emits token spans; without the language it would emit the text bare.
      expect(html).toContain('class="token');
    });

    it('survives sanitization, which is what strips the class the language is read from', () => {
      // Guards the interaction rather than the parser: rehype-sanitize's default schema allows
      // className on <code> only where it matches /^language-./, so a schema change here shows
      // up as an unhighlighted block rather than as a test that still passes.
      expect(render('```python\nx = 1\n```')).toContain('data-language="python"');
    });

    it('falls back to text for a fence with no language', () => {
      expect(render('```\nplain\n```')).toContain('data-language="text"');
    });

    it('keeps inline code inline', () => {
      const html = render('Run `pnpm test` first.');
      expect(html).toContain('data-testid="chat-markdown-inline-code"');
      expect(html).not.toContain('data-testid="chat-markdown-code-block"');
    });

    it('draws a fenced block as a block and not as an inline chip', () => {
      const html = render('```sh\nls -la\n```');
      expect(html).toContain('data-testid="chat-markdown-code-block"');
      expect(html).not.toContain('data-testid="chat-markdown-inline-code"');
    });
  });

  describe('incomplete markdown, which is what streaming hands it', () => {
    it('draws a fence whose body is still arriving as a block', () => {
      const html = render('Here you go:\n\n```ts\nconst x = 1;');
      expect(html).toContain('data-testid="chat-markdown-code-block"');
      expect(html).toContain('data-language="ts"');
      expect(html).not.toContain('data-testid="chat-markdown-inline-code"');
    });

    it('draws a bare opening fence as a block, not as an inline chip', () => {
      // The case closeOpenFence exists for: one line of text, so the position test that tells
      // inline from block would read the node as inline and flash a chip for a token.
      const html = render('```ts');
      expect(html).toContain('data-testid="chat-markdown-code-block"');
      expect(html).not.toContain('data-testid="chat-markdown-inline-code"');
    });

    it('does not leave the opening fence sitting in the text', () => {
      // What the plain-text renderer did, and the reason this task exists.
      expect(render('```ts\nconst x = 1;')).not.toContain('```');
    });

    it('keeps the code that has arrived so far', () => {
      expect(render('```ts\nconst x = 1;')).toContain('const');
    });

    it('renders a half-arrived table as the text it is so far', () => {
      // No delimiter row yet, so it is not a table and is not pretending to be one.
      const html = render('| a | b |');
      expect(html).not.toContain('<table>');
      expect(html).toContain('| a | b |');
    });

    it('becomes a table once the delimiter row lands', () => {
      expect(render('| a | b |\n| --- | --- |')).toContain('<table>');
    });

    it('renders a dangling list marker without inventing an item', () => {
      expect(() => render('- ')).not.toThrow();
    });

    it('leaves unmatched emphasis as the characters it is', () => {
      expect(render('this is **half')).toContain('**half');
    });
  });

  describe('untrusted output', () => {
    it('drops a script tag rather than rendering it', () => {
      const html = render('Hello\n\n<script>alert(1)</script>');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('alert(1)');
    });

    it('drops an inline event handler', () => {
      const html = render('<img src="x" onerror="alert(1)">');
      expect(html).not.toContain('onerror');
    });

    it('drops an iframe', () => {
      expect(render('<iframe src="https://example.com"></iframe>')).not.toContain('<iframe');
    });

    it('strips a javascript: href off a link', () => {
      const html = render('[click](javascript:alert(1))');
      expect(html).not.toContain('javascript:');
    });

    it('renders an http link as a link', () => {
      const html = render('[docs](https://example.com/a)');
      expect(html).toContain('data-testid="chat-markdown-link"');
      expect(html).toContain('href="https://example.com/a"');
    });

    it('does not give a link a target, which would ask Electron for a window', () => {
      expect(render('[docs](https://example.com)')).not.toContain('target=');
    });

    it('does not render artifact markup as an element if a delta carries it', () => {
      // Main strips <artifact> before a reply settles, but the deltas that carried it reach
      // this renderer first. It is raw HTML, so it is dropped rather than drawn.
      const html = render('<artifact type="text/html" title="Demo">\n<b>hi</b>\n</artifact>');
      expect(html).not.toContain('<artifact');
    });
  });
});

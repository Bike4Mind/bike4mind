import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { type Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { assistantReplyRemarkPlugins, promoteInlineLatexDollars } from '@client/app/utils/remarkPlugins';
import { splitStreamingMarkdown } from './streamingSplit';

const remarkPlugins: Options['remarkPlugins'] = [...assistantReplyRemarkPlugins];
const rehypePlugins: Options['rehypePlugins'] = [rehypeKatex];
const remarkRehypeOptions: Options['remarkRehypeOptions'] = { clobberPrefix: 'fn-r-' };

const normalize = (html: string) => html.replace(/>\s+</g, '><');

const md = (text: string) =>
  text
    ? normalize(
        renderToStaticMarkup(
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            remarkRehypeOptions={remarkRehypeOptions}
          >
            {text}
          </ReactMarkdown>
        )
      )
    : '';

const splitRender = (text: string) => {
  const { committed, tail } = splitStreamingMarkdown(text);
  return md(committed) + md(tail);
};

const committedOf = (text: string) => splitStreamingMarkdown(text).committed;

describe('splitStreamingMarkdown never cuts inside a block (render oracle)', () => {
  it('does not cut inside a ``` fence whose body has a line starting with ```lang (not a closer)', () => {
    const text = [
      '```markdown',
      'Example:',
      '```js',
      'console.log(1)',
      '',
      'console.log(2)',
      '```',
      '',
      'after the example',
    ].join('\n');
    expect(splitRender(text)).toBe(md(text));
  });

  it('does not cut inside a fence whose would-be closer is indented four spaces', () => {
    const text = ['```', 'a', '    ```', '', 'still code', '```', '', 'tail para'].join('\n');
    expect(splitRender(text)).toBe(md(text));
  });

  it('keeps a ~~~ fence containing a blank line together', () => {
    const text = 'intro\n\n~~~py\nx = 1\n\ny = 2\n';
    expect(committedOf(text)).toBe('intro\n\n');
    expect(splitRender(text)).toBe(md(text));
  });

  it('keeps a four-backtick fence holding a ``` fence together', () => {
    const text = 'intro\n\n````md\n```js\nx\n```\n\nmore\n';
    expect(committedOf(text)).toBe('intro\n\n');
    expect(splitRender(text)).toBe(md(text));
  });

  it('keeps an indented fence inside a list item together', () => {
    const text = '1. step\n\n   ```sh\n   echo a\n\n   echo b\n   ```\n\nnext para';
    expect(splitRender(text)).toBe(md(text));
  });

  it('keeps a promoted \\[ \\] own-line block intact', () => {
    const text = promoteInlineLatexDollars('intro\n\n\\[\nx^2\n\\]\n\nafter text');
    expect(splitRender(text)).toBe(md(text));
  });

  it('does not cut a GFM table that started without a blank line before it', () => {
    const text = 'intro\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter';
    expect(splitRender(text)).toBe(md(text));
  });

  it('does not cut a list item continuation paragraph', () => {
    const text = '- item one\n\n  continued item one\n- item two';
    expect(committedOf(text)).toBe('');
  });

  it('does not cut a footnote definition continuation', () => {
    const text = 'Claim[^1].\n\n[^1]: first line\n\n    second para of note\n';
    expect(splitRender(text)).not.toContain('<pre>');
  });

  it('leaves a reference-style link raw until completion; its definition is its own block', () => {
    const text = 'See [the docs][d] for more.\n\n[d]: https://example.com/docs\n';
    expect(splitRender(text)).toBe('<p>See [the docs][d] for more.</p>');
    expect(md(text)).toContain('<a href="https://example.com/docs">');
  });

  it('leaves a footnote reference raw until completion and renders no section mid-stream', () => {
    const text = 'A claim[^1] here.\n\n[^1]: The source.\n';
    expect(splitRender(text)).toBe('<p>A claim[^1] here.</p>');
    expect(md(text)).toContain('<section data-footnotes');
  });

  it('keeps a loose list rendering as one loose list mid-stream', () => {
    const text = '1. alpha\n\n2. beta\n\n3. gam';
    expect(splitRender(text)).toBe(md(text));
  });

  it('every line-prefix of a mixed reply: committed is a prefix and parts concatenate back', () => {
    const text = [
      '# Title',
      '',
      'Intro with $x^2$ and a [ref][r].',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '- one',
      '  - nested',
      '',
      '```ts',
      'const a = 1;',
      '',
      'const b = 2;',
      '```',
      '',
      '$$',
      'e = mc^2',
      '',
      '$$',
      '',
      '[r]: https://example.com',
    ].join('\n');
    for (let i = 0; i <= text.length; i++) {
      const prefix = text.slice(0, i);
      const { committed, tail } = splitStreamingMarkdown(prefix);
      expect(committed + tail).toBe(prefix);
      if (committed) expect(committed.endsWith('\n\n') || committed.endsWith('\n')).toBe(true);
    }
  });
});

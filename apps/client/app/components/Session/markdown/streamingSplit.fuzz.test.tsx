import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { type Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { assistantReplyRemarkPlugins } from '@client/app/utils/remarkPlugins';
import { createBlockParser, splitStreamingBlocks, type StreamingBlocks } from './streamingSplit';

const remarkPlugins: Options['remarkPlugins'] = [...assistantReplyRemarkPlugins];
const rehypePlugins: Options['rehypePlugins'] = [rehypeKatex];
const parse = createBlockParser(remarkPlugins);

const md = (text: string) =>
  text
    ? renderToStaticMarkup(
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
          {text}
        </ReactMarkdown>
      )
    : '';

const streamChained = (text: string, step: (i: number) => number = () => 1) => {
  let prev: StreamingBlocks | undefined;
  const violations: string[] = [];
  for (let i = 0; i < text.length;) {
    i = Math.min(text.length, i + step(i));
    const prefix = text.slice(0, i);
    const next = splitStreamingBlocks(prefix, parse, prev);
    if (next.blocks.join('') + next.tail !== prefix) violations.push(`reassembly at ${i}`);
    if (prev && prev.blocks.some((b, k) => next.blocks[k] !== b)) violations.push(`block rewritten at ${i}`);
    prev = next;
  }
  return { split: prev!, violations };
};

const perBlockHtml = (split: StreamingBlocks) => [...split.blocks, split.tail].filter(Boolean).map(md).join('\n');

const streamedRender = (text: string) => {
  const { split } = streamChained(text);
  return split.crossBlock ? md(text) : perBlockHtml(split);
};

const topLevelStarts = (text: string) => new Set((parse(text).children ?? []).map(n => n.position!.start.offset));

const FRAGMENTS = [
  'Plain *em* and **strong** with `code` and [1].',
  'Hard break  \nnext line',
  'Soft\nbreak',
  '## Heading',
  'Title\n=====',
  '---',
  '- a\n- b',
  '- a\n\n- b',
  '- a\n  - nested\n\n  - nested2\n- b',
  '1. one\n2. two',
  '1) one\n\n2) two',
  '1. **Install** it\nwith npm\n\n2. run',
  '* star\n\n+ plus',
  '> quote\n>\n> more',
  '> lazy\ncontinued',
  '```js\nconst a = 1;\n\nconst b = 2;\n```',
  '~~~\nx\n\ny\n~~~',
  '1. step\n   ```bash\n   npm i\n\n   npm t\n   ```\n2. next',
  '- item\n\n  continued para\n\n  ```\n  code\n  ```',
  '$$\nx^2\n\n+ y\n$$',
  '| a | b |\n|---|:-:|\n| 1 | 2 |',
  '    indented code\n\n    more code',
  '<details>\n<summary>s</summary>\n\nbody\n\n</details>',
  '<pre>\na\n\nb\n</pre>',
  '<!--\nnote\n\nmore\n-->',
  'line with spaces\n   \nafter spaces line',
  '- tab item\n\n\tcontinued by tab',
  '- a\n\n    indented after list',
  '1. a\n\n10. b',
  '[^1]: a note\n\n    continued note',
  'See [ref] and [^1].',
  '[ref]: https://example.com/ref',
];
const SEPARATORS = ['\n\n', '\n\n', '\n', '\n\n\n', '\n  \n'];

const corpus = (count: number, seedStart: number) => {
  let seed = seedStart;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  return Array.from({ length: count }, () => {
    let text = FRAGMENTS[next(FRAGMENTS.length)];
    const parts = 2 + next(6);
    for (let i = 1; i < parts; i++) text += SEPARATORS[next(SEPARATORS.length)] + FRAGMENTS[next(FRAGMENTS.length)];
    return text;
  });
};

describe('splitStreamingBlocks soundness fuzz', () => {
  it('only appends blocks, reassembles every prefix, cuts at full-parse node starts, and renders like the single parse', () => {
    const failures: string[] = [];
    for (const text of corpus(80, 4040)) {
      const { split, violations } = streamChained(text);
      const starts = topLevelStarts(text);
      let at = 0;
      for (const block of split.blocks) {
        at += block.length;
        if (!starts.has(at)) violations.push(`cut at ${at} is not a node start`);
      }
      if (!split.crossBlock && perBlockHtml(split) !== md(text)) violations.push('render differs');
      if (violations.length) failures.push(`${JSON.stringify(text)}: ${violations.join(', ')}`);
    }
    expect(failures).toEqual([]);
  });
});

const PROBES: Record<string, string> = {
  'fence indented 2 under an ordered item': '1. Run this:\n\n  ```bash\n  npm i\n  npm test\n  ```\n\nDone.',
  'fence indented 3 under a 10. item': '10. Run this:\n\n   ```bash\n   npm i\n   ```\n\nDone.',
  'indented paragraph': 'intro\n\n   indented para\n\nend',
  'indented list with a deeper continuation': 'intro\n\n  - item\n\n      deeper para\n\nend',
  'indented table': 'intro\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n\nend',
  'indented heading': 'intro\n\n  ## Head\n\nend',
  'indented blockquote with fence': 'intro\n\n  > ```\n  >   code\n  > ```\n\nend',
  'pre html block with blank lines': 'intro\n\n<pre>\na\n\nb\n</pre>\n\nend',
  'comment html block': 'intro\n\n<!--\na\n\nb\n-->\n\nend',
  'processing html block': 'intro\n\n<?\na\n\nb\n?>\n\nend',
  'cdata html block': 'intro\n\n<![CDATA[\na\n\nb\n]]>\n\nend',
  'declaration html block': 'intro\n\n<!X\na\n\nb\n>\n\nend',
  'unclosed fence': 'intro\n\n```\na\n\nb',
  'unclosed math': 'intro\n\n$$\na\n\nb',
  'spaces-only line in a paragraph': 'one\n   \ntwo\n\nthree',
  'list then indented code-looking line': '- a\n\n    b\n\nc',
  'list then different marker': '- a\n\n* b\n\n1. c\n\n1) d',
  'list item continued with a tab': '- a\n\n\tb\n\nc',
  'blockquote lazy then blank': '> a\nlazy\n\nb',
};

describe('splitStreamingBlocks targeted constructs', () => {
  for (const [name, text] of Object.entries(PROBES)) {
    it(`streams "${name}" char by char and renders like the single parse`, () => {
      const { violations } = streamChained(text);
      expect(violations).toEqual([]);
      expect(streamedRender(text)).toBe(md(text));
    });
  }
});

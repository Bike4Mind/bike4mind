import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { type Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { assistantReplyRemarkPlugins } from '@client/app/utils/remarkPlugins';
import { splitStreamingBlocks } from './streamingSplit';

const remarkPlugins: Options['remarkPlugins'] = [...assistantReplyRemarkPlugins];
const rehypePlugins: Options['rehypePlugins'] = [rehypeKatex];

const md = (text: string) =>
  text
    ? renderToStaticMarkup(
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
          {text}
        </ReactMarkdown>
      ).replace(/>\s+</g, '><')
    : '';

const splitRender = (text: string) => {
  const { blocks, tail } = splitStreamingBlocks(text);
  return [...blocks, tail].map(md).join('');
};

const frames = (text: string) => Array.from({ length: text.length }, (_, i) => text.slice(0, i + 1));

describe('splitStreamingBlocks render oracle across frames', () => {
  it('does not cut inside a fence when the reply uses CRLF line endings', () => {
    const text = 'intro\r\n\r\n```js\r\nconst a = 1;\r\n\r\nconst b = 2;\r\n```\r\n\r\nafter';
    expect(splitRender(text)).toBe(md(text));
  });

  it('does not cut a paragraph at a line holding only a non-breaking space', () => {
    const text = 'line one\n\u00a0\nline two\n\nend';
    expect(splitRender(text)).toBe(md(text));
  });

  it('keeps blank-separated GFM rows, nested loose lists and blockquote fences equal to the single parse', () => {
    const cases = [
      '| a | b |\n|---|---|\n| 1 | 2 |\n\n| 3 | 4 |\n\nafter',
      '- a\n  - b\n\n  - c\n\n- d\n\ntext',
      '> ```\n> a\n\n> b\n> ```\n\nafter',
      '- a\n\n\tcontinued\n\nend',
      '- a\n\n- - -\n\nPara',
      'para\n\n    $$\n\nx\n\ny',
    ];
    for (const text of cases) expect(splitRender(text)).toBe(md(text));
  });

  it('leaves reference links raw until completion when their definitions trail the reply', () => {
    const text = 'text [a] [b]\n\n[a]: http://a\n\n[b]: http://b';
    expect(splitRender(text)).toBe('<p>text [a] [b]</p>');
    expect(splitStreamingBlocks(text).crossBlock).toBe(true);
  });
});

describe('settled blocks only grow across frames', () => {
  const corpus = [
    '# Plan\n\nIntro para.\n\n1. one\n\n2. two\n\n- x\n- y\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n$$\nx\n\ny\n$$\n\nEnd.',
    'Answer.\n\n> quote\n>\n> more\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~~\nz\n\nw\n~~~\n\nDone.',
  ];
  it('never changes or drops an earlier settled block on plausible replies without definitions', () => {
    for (const text of corpus) {
      let prev: string[] = [];
      for (const frame of frames(text)) {
        const { blocks } = splitStreamingBlocks(frame);
        expect(blocks.slice(0, prev.length)).toEqual(prev);
        prev = blocks;
      }
    }
  });

  it('a partial `[x]` line that becomes a definition keeps the block before it settled and flags the reply', () => {
    const a = splitStreamingBlocks('text [a]\n\n[a]');
    const b = splitStreamingBlocks('text [a]\n\n[a]: http://a');
    expect(a.blocks).toEqual(['text [a]\n\n']);
    expect(a.crossBlock).toBe(false);
    expect(b.blocks).toEqual(['text [a]\n\n']);
    expect(b.crossBlock).toBe(true);
  });
});

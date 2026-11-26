import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { type Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { assistantReplyRemarkPlugins } from '@client/app/utils/remarkPlugins';
import { createBlockParser, splitStreamingBlocks, type StreamingBlocks } from './streamingSplit';

export const replyParser = createBlockParser(assistantReplyRemarkPlugins);

const remarkPlugins: Options['remarkPlugins'] = [...assistantReplyRemarkPlugins];
const rehypePlugins: Options['rehypePlugins'] = [rehypeKatex];

/** The single-parse render of a reply, the oracle the split renders are compared against. */
export const createMd = (remarkRehypeOptions?: Options['remarkRehypeOptions']) => (text: string) =>
  text
    ? renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins, rehypePlugins, remarkRehypeOptions }, text))
    : '';

export const md = createMd();

export const normalizeHtml = (html: string) => html.replace(/>\s+</g, '><');

/** The settled blocks joined back together, and the live tail. */
export const splitStreamingMarkdown = (text: string) => {
  const { committed, tail } = splitStreamingBlocks(text, replyParser);
  return { committed, tail };
};

export const perBlockHtml = (split: StreamingBlocks) =>
  [...split.blocks, split.tail].filter(Boolean).map(md).join('\n');

export const chunkedPrefixes = (text: string, chunks: number[]) => {
  const out: string[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    i = Math.min(text.length, i + chunks[k % chunks.length]);
    k++;
    out.push(text.slice(0, i));
  }
  return out;
};

// Same chain twice: as shipped (skip allowed) and with every frame forced to parse.
export const compareWithAlwaysParse = (prefixes: string[]) => {
  let skip: StreamingBlocks | undefined;
  let always: StreamingBlocks | undefined;
  let lagFrames = 0;
  let maxLagBytes = 0;
  for (const prefix of prefixes) {
    skip = splitStreamingBlocks(prefix, replyParser, skip);
    always = splitStreamingBlocks(prefix, replyParser, always, true);
    const settledSkip = skip.blocks.join('').length;
    const settledAlways = always.blocks.join('').length;
    if (settledAlways > settledSkip) {
      lagFrames++;
      maxLagBytes = Math.max(maxLagBytes, settledAlways - settledSkip);
    }
  }
  return { skip: skip!, always: always!, lagFrames, frames: prefixes.length, maxLagBytes };
};

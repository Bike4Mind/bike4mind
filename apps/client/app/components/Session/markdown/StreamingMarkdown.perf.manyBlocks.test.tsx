import React from 'react';
import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { appendFileSync } from 'fs';
import { assistantReplyRemarkPlugins } from '@client/app/utils/remarkPlugins';
import { StreamingMarkdown } from './StreamingMarkdown';
import { splitStreamingBlocks } from './streamingSplit';

const components: Components = {};
const remarkPlugins: Options['remarkPlugins'] = [...assistantReplyRemarkPlugins];
const rehypePlugins: Options['rehypePlugins'] = [rehypeKatex];
const remarkRehypeOptions: Options['remarkRehypeOptions'] = { clobberPrefix: 'fn-perf2-' };
const OUT = process.env.B4M_PERF_OUT;

const report = (line: string) => {
  if (OUT) appendFileSync(OUT, `${line}\n`);
};

const reply = (paragraphs: number) =>
  Array.from({ length: paragraphs }, (_, i) => `Paragraph ${i} explains one more short point about caching.`).join(
    '\n\n'
  );

const Streaming = ({ text }: { text: string }) => (
  <StreamingMarkdown
    text={text}
    streaming
    components={components}
    remarkPlugins={remarkPlugins}
    rehypePlugins={rehypePlugins}
    remarkRehypeOptions={remarkRehypeOptions}
  />
);

const Full = ({ text }: { text: string }) => (
  <ReactMarkdown
    components={components}
    remarkPlugins={remarkPlugins}
    rehypePlugins={rehypePlugins}
    remarkRehypeOptions={remarkRehypeOptions}
  >
    {text}
  </ReactMarkdown>
);

const lastFrames = (text: string, el: (t: string) => React.ReactElement, frames = 10) => {
  const { rerender, unmount } = render(el(text.slice(0, text.length - frames * 8)));
  const start = performance.now();
  for (let i = frames - 1; i >= 0; i--) act(() => rerender(el(text.slice(0, text.length - i * 8))));
  const perFrame = (performance.now() - start) / frames;
  unmount();
  return perFrame;
};

const offsetsCost = (text: string) => {
  const { blocks, tail } = splitStreamingBlocks(text);
  const parts = [...blocks, tail];
  const countLines = (t: string) => t.split('\n').length - 1;
  const start = performance.now();
  parts.map((_, i) => parts.slice(0, i).reduce((lines, part) => lines + countLines(part), 0));
  return { blocks: parts.length, ms: performance.now() - start };
};

describe.skipIf(!process.env.B4M_PERF)('StreamingMarkdown per-frame cost on long many-block replies', () => {
  it('a streamed frame of a 2000-block reply costs no more than one full parse (base)', () => {
    let streaming2000 = 0;
    let full2000 = 0;
    for (const n of [200, 1000, 2000, 4000]) {
      const text = reply(n);
      const off = offsetsCost(text);
      const s = lastFrames(text, t => <Streaming text={t} />);
      const f = n <= 2000 ? lastFrames(text, t => <Full text={t} />, 3) : NaN;
      if (n === 2000) {
        streaming2000 = s;
        full2000 = f;
      }
      report(
        `paragraphs ${n} bytes ${text.length} blocks ${off.blocks} offsets-only ms ${off.ms.toFixed(1)} ` +
          `streaming per-frame ms ${s.toFixed(1)} full-parse per-frame ms ${f.toFixed(1)}`
      );
    }
    expect(streaming2000).toBeLessThanOrEqual(full2000);
  });
});

import React, { type ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { type Components, type Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { assistantReplyRemarkPlugins } from '@client/app/utils/remarkPlugins';
import * as split from './streamingSplit';
import { StreamingMarkdown } from './StreamingMarkdown';

vi.mock('./streamingSplit', async importOriginal => {
  const actual = await importOriginal<typeof import('./streamingSplit')>();
  return {
    ...actual,
    createBlockParser: vi.fn(actual.createBlockParser),
    splitStreamingBlocks: vi.fn(actual.splitStreamingBlocks),
  };
});

const remarkPlugins: Options['remarkPlugins'] = [...assistantReplyRemarkPlugins];
const rehypePlugins: Options['rehypePlugins'] = [rehypeKatex];
const remarkRehypeOptions: Options['remarkRehypeOptions'] = { clobberPrefix: 'fn-q4-' };
const NO_COMPONENTS: Components = {};

const Subject = ({
  text,
  streaming,
  components = NO_COMPONENTS,
  plugins = remarkPlugins,
}: {
  text: string;
  streaming: boolean;
  components?: Components;
  plugins?: Options['remarkPlugins'];
}) => (
  <StreamingMarkdown
    text={text}
    streaming={streaming}
    components={components}
    remarkPlugins={plugins}
    rehypePlugins={rehypePlugins}
    remarkRehypeOptions={remarkRehypeOptions}
  />
);

const streamThenComplete = (text: string, components: Components = NO_COMPONENTS) => {
  const view = render(<Subject text="" streaming components={components} />);
  for (let i = 1; i <= text.length; i++) view.rerender(<Subject text={text.slice(0, i)} streaming components={components} />);
  view.rerender(<Subject text={text} streaming={false} components={components} />);
  return view;
};

describe('StreamingMarkdown round 4', () => {
  it('keeps the code of a fence indented under an ordered list item unindented after streaming', () => {
    const text = '1. Run this:\n\n  ```bash\n  npm i\n  npm test\n  ```\n\nDone.';
    const streamed = streamThenComplete(text);
    const streamedCode = streamed.container.querySelector('code')?.textContent;
    streamed.unmount();
    const mounted = render(<Subject text={text} streaming={false} />);
    expect(mounted.container.querySelector('code')?.textContent).toBe('npm i\nnpm test\n');
    expect(streamedCode).toBe('npm i\nnpm test\n');
  });

  it('renders the tail block once per frame and settled blocks not at all, despite the setState during render', () => {
    const renders = new Map<string, number>();
    const components: Components = {
      p: ({ children }: ComponentProps<'p'>) => {
        const key = String(React.Children.toArray(children)[0]).slice(0, 8);
        renders.set(key, (renders.get(key) ?? 0) + 1);
        return <p>{children}</p>;
      },
    };
    const head = 'settled one\n\nsettled two\n\n';
    const view = render(<Subject text={`${head}tail`} streaming components={components} />);
    renders.clear();
    const frames = 20;
    for (let i = 0; i < frames; i++) {
      view.rerender(<Subject text={`${head}tail${'x'.repeat(i + 1)}`} streaming components={components} />);
    }
    expect(renders.get('settled ')).toBeUndefined();
    const tailRenders = [...renders.entries()].filter(([k]) => k.startsWith('tail')).reduce((n, [, c]) => n + c, 0);
    expect(tailRenders).toBe(frames);
  });

  it('splits each frame once and does not rebuild the parser while remarkPlugins keeps its identity', () => {
    const view = render(<Subject text="a" streaming />);
    vi.mocked(split.splitStreamingBlocks).mockClear();
    vi.mocked(split.createBlockParser).mockClear();
    for (let i = 0; i < 10; i++) view.rerender(<Subject text={`a\n\nb${i}`} streaming />);
    view.rerender(<Subject text={'a\n\nb9'} streaming />);
    expect(vi.mocked(split.splitStreamingBlocks)).toHaveBeenCalledTimes(10);
    expect(vi.mocked(split.createBlockParser)).not.toHaveBeenCalled();
  });

  it('costs little to rebuild the parser on every render when the parent passes new remarkPlugins each time', () => {
    const view = render(<Subject text="a" streaming plugins={[...assistantReplyRemarkPlugins]} />);
    vi.mocked(split.createBlockParser).mockClear();
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      act(() => view.rerender(<Subject text={`a\n\nb${i}`} streaming plugins={[...assistantReplyRemarkPlugins]} />));
    }
    const elapsed = performance.now() - start;
    expect(vi.mocked(split.createBlockParser)).toHaveBeenCalledTimes(50);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) split.createBlockParser([...assistantReplyRemarkPlugins])('x');
    const perParser = (performance.now() - t0) / 200;
    console.log(`50 frames with unstable plugins ${elapsed.toFixed(1)} ms; parser build + first parse ${perParser.toFixed(3)} ms`);
    expect(perParser).toBeLessThan(2);
  });
});

describe.skipIf(!process.env.B4M_PERF)('StreamingMarkdown round 4 cost breakdown', () => {
  it('splits where the streamed-frame time goes', async () => {
    const actual = await vi.importActual<typeof import('./streamingSplit')>('./streamingSplit');
    let answer = '';
    const para = 'A write-through cache keeps reads cheap at the cost of write latency.\n\n';
    const code = '```ts\nconst hit = cache.get(key);\nif (hit !== undefined) return hit;\n```\n\n';
    const list = '- Write-through\n- Write-back\n- Write-around\n\n';
    while (answer.length < 6 * 1024) answer += `## Section\n\n${para}${list}${code}| a | b |\n|---|---|\n| 1 | 2 |\n\n`;
    const frames = Array.from({ length: 60 }, (_, i) => answer.slice(0, Math.ceil((answer.length * (i + 1)) / 60)));
    let splitMs = 0;
    vi.mocked(split.splitStreamingBlocks).mockImplementation((...args) => {
      const t = performance.now();
      const result = actual.splitStreamingBlocks(...args);
      splitMs += performance.now() - t;
      return result;
    });
    const run = () => {
      const view = render(<Subject text="" streaming />);
      const t = performance.now();
      for (const f of frames) act(() => view.rerender(<Subject text={f} streaming />));
      const total = performance.now() - t;
      view.unmount();
      return total;
    };
    run();
    splitMs = 0;
    const total = run();
    console.log(`60 frames: total ${total.toFixed(1)} ms, splitStreamingBlocks ${splitMs.toFixed(1)} ms`);
    vi.mocked(split.splitStreamingBlocks).mockImplementation(actual.splitStreamingBlocks);
    expect(total).toBeGreaterThan(0);
  });
});

describe.skipIf(!process.env.B4M_PERF)('StreamingMarkdown round 4 replies that never settle', () => {
  const measure = (frames: string[], el: (t: string) => React.ReactElement) => {
    const view = render(el(''));
    const t = performance.now();
    for (const f of frames) act(() => view.rerender(el(f)));
    const total = performance.now() - t;
    view.unmount();
    return total;
  };
  const single = (t: string) => <Subject text={t} streaming={false} />;
  const streamed = (t: string) => <Subject text={t} streaming />;

  it.each([
    [
      'one loose bullet list with code in every item',
      (i: number) => `- **Step ${i + 1}**: configure the service.\n\n  Run the command below and check the output.\n\n  \`\`\`bash\n  npm run step-${i + 1}\n  \`\`\`\n\n`,
    ],
    ['one long table', (i: number) => (i === 0 ? '| a | b | c |\n|---|---|---|\n' : `| row ${i} | value ${i} | note ${i} |\n`)],
    ['one long tight bullet list', (i: number) => `- **Item ${i}**: a short note with \`code\` and a [link](https://example.com/${i})\n`],
    ['one long fenced code block', (i: number) => (i === 0 ? '```ts\n' : `const value${i} = compute(${i}, 'label-${i}');\n`)],
  ])('compares the streamed path with a full re-parse for %s', (_name, unit) => {
    let answer = '';
    for (let i = 0; answer.length < 6 * 1024; i++) answer += unit(i);
    const frames = Array.from({ length: 60 }, (_, i) => answer.slice(0, Math.ceil((answer.length * (i + 1)) / 60)));
    measure(frames.slice(-3), single);
    measure(frames.slice(-3), streamed);
    const a = measure(frames, single);
    const b = measure(frames, streamed);
    console.log(`${_name}: A full re-parse ${a.toFixed(1)} ms, B streamed ${b.toFixed(1)} ms`);
    expect(b).toBeLessThan(a * 1.1);
  });
});

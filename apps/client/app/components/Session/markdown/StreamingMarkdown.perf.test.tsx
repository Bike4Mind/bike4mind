import React, { type ComponentProps } from 'react';
import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { assistantReplyRemarkPlugins } from '@client/app/utils/remarkPlugins';
import { StreamingMarkdown } from './StreamingMarkdown';

const FRAMES = 60;
const TARGET_BYTES = 6 * 1024;

const components: Components = {
  code: ({ children, className }: ComponentProps<'code'>) => <code className={className}>{children}</code>,
};
const remarkPlugins: Options['remarkPlugins'] = [...assistantReplyRemarkPlugins];
const rehypePlugins: Options['rehypePlugins'] = [rehypeKatex];
const remarkRehypeOptions: Options['remarkRehypeOptions'] = { clobberPrefix: 'fn-perf-' };

const SECTION = [
  '## Choosing a cache strategy',
  '',
  'A write-through cache keeps reads cheap at the cost of write latency; the expected hit rate',
  'follows $h = 1 - e^{-\\lambda t}$ for a Poisson access pattern with rate $\\lambda$.',
  '',
  '- Write-through: every write updates the cache and the store.',
  '- Write-back: writes land in the cache and flush later.',
  '- Write-around: writes skip the cache entirely.',
  '',
  '```ts',
  'export function readThrough<K, V>(cache: Map<K, V>, key: K, load: (k: K) => V): V {',
  '  const hit = cache.get(key);',
  '  if (hit !== undefined) return hit;',
  '  const value = load(key);',
  '  cache.set(key, value);',
  '  return value;',
  '}',
  '```',
  '',
  '| Strategy | Read cost | Write cost |',
  '|---|---|---|',
  '| Write-through | low | high |',
  '| Write-back | low | low |',
  '| Write-around | medium | low |',
  '',
  '### Eviction',
  '',
  '```python',
  'def evict(cache, limit):',
  '    while len(cache) > limit:',
  '        cache.popitem(last=False)',
  '```',
  '',
  'In practice the eviction policy matters less than sizing the cache to the working set.',
  '',
].join('\n');

const buildAnswer = () => {
  let answer = '';
  while (answer.length < TARGET_BYTES) answer += SECTION;
  return answer;
};

const prefixes = (text: string) =>
  Array.from({ length: FRAMES }, (_, i) => text.slice(0, Math.ceil((text.length * (i + 1)) / FRAMES)));

const measure = (frames: string[], renderFrame: (text: string) => React.ReactElement) => {
  const { rerender, unmount } = render(renderFrame(''));
  const times = frames.map(text => {
    const start = performance.now();
    act(() => rerender(renderFrame(text)));
    return performance.now() - start;
  });
  unmount();
  const sorted = [...times].sort((a, b) => a - b);
  return {
    total: times.reduce((sum, t) => sum + t, 0),
    p50: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
};

const fullParse = (text: string) => (
  <ReactMarkdown
    components={components}
    remarkPlugins={remarkPlugins}
    rehypePlugins={rehypePlugins}
    remarkRehypeOptions={remarkRehypeOptions}
  >
    {text}
  </ReactMarkdown>
);

const frozenPrefix = (text: string) => (
  <StreamingMarkdown
    text={text}
    streaming
    components={components}
    remarkPlugins={remarkPlugins}
    rehypePlugins={rehypePlugins}
    remarkRehypeOptions={remarkRehypeOptions}
  />
);

describe.skipIf(!process.env.B4M_PERF)('StreamingMarkdown benchmark', () => {
  it('compares full re-parse (A) with the frozen prefix (B) over a streamed reply', () => {
    const answer = buildAnswer();
    const frames = prefixes(answer);
    // Warm both paths so JIT and module init do not land in the first variant measured.
    measure(frames.slice(-3), fullParse);
    measure(frames.slice(-3), frozenPrefix);

    const a = measure(frames, fullParse);
    const b = measure(frames, frozenPrefix);
    const fmt = (n: number) => n.toFixed(1);
    console.log(
      [
        `reply ${answer.length} bytes, ${FRAMES} frames`,
        `A total ms ${fmt(a.total)}`,
        `B total ms ${fmt(b.total)}`,
        `A per-frame p50/max ${fmt(a.p50)}/${fmt(a.max)}`,
        `B per-frame p50/max ${fmt(b.p50)}/${fmt(b.max)}`,
      ].join('\n')
    );
    expect(b.total).toBeGreaterThan(0);
  });
});

import { describe, it, expect, vi } from 'vitest';
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  assertOutboundActionAllowed: async () => undefined,
}));

type RouteHandler = (request: unknown, response: unknown) => unknown;
const route = vi.hoisted(() => ({
  handler: null as RouteHandler | null,
  admit: vi.fn().mockResolvedValue({ release: async () => {} }),
}));
vi.mock('@server/utils/untrustedCompletionQuota', () => ({ admitRequestCompletion: route.admit }));
import {
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  regexDivergences,
  seededCorpus,
  FENCE_PIECES,
} from '@client/__tests__/utils/regexLinearity';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (...handlers: RouteHandler[]) => {
      const handler = handlers[handlers.length - 1];
      route.handler = handler;
      return handler;
    },
  }),
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({ getPublishedArtifactsStorage: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ PublishedArtifact: {}, Annotation: {} }));
vi.mock('@server/services/publish', () => ({
  validateBundle: vi.fn(),
  buildPublishUrlPath: vi.fn(),
  invalidatePublishCdn: vi.fn(),
  toCacheTarget: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({ OperationsModelService: vi.fn() }));

import { stripFences } from '../revise';

it('rejects a quota refusal before accessing the published artifact or generating a revision', async () => {
  const error = new Error('completion quota exhausted');
  route.admit.mockRejectedValueOnce(error);
  const request = { user: { id: 'owner-1' } };
  await expect(route.handler!(request, {})).rejects.toBe(error);
  expect(route.admit).toHaveBeenCalledWith(request, { holdSlot: true });
});

describe('stripFences', () => {
  const OLD_FENCE = /^```[a-z]*\s*\n([\s\S]*?)\n```$/i;
  const NEW_FENCE = /^```[a-z]*[^\S\n]*\n([\s\S]*?)\n```$/i;

  it('strips a whole-response fence and leaves other text alone', () => {
    expect(stripFences('```html \n<p>hi</p>\n```')).toBe('<p>hi</p>');
    expect(stripFences('<p>```</p>')).toBe('<p>```</p>');
  });

  // The old regex took about 1-3s per call at 24000.
  it.each([
    ['newlines after an unclosed fence', (n: number) => '```html' + '\n'.repeat(n) + 'x', 24000],
    ['space-newline pairs after an unclosed fence', (n: number) => '```html' + ' \n'.repeat(n) + 'x', 24000],
  ])('stays linear on %s', (_label, build, small) => {
    const { baselineMs, ratio } = measureGrowth(stripFences, build, small);
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });

  it('matches the old regex on every seeded input once captures are trimmed', () => {
    // The regex is anchored at both ends, so half the corpus is wrapped as an opener + body + closer.
    const raw = seededCorpus(2998, 1500, [...FENCE_PIECES, 'html', '<p>'], 8);
    const corpus = [...raw, ...raw.map(s => '```' + s + '\n```')];
    expect(corpus.filter(s => NEW_FENCE.test(s)).length).toBeGreaterThan(300);
    expect(regexDivergences(OLD_FENCE, NEW_FENCE, corpus)).toEqual([]);
    // Control: letting the prefix swallow newlines diverges, so this differential can fail.
    expect(regexDivergences(OLD_FENCE, /^```[a-z]*\s*([\s\S]*?)\n```$/i, corpus).length).toBeGreaterThan(0);
  });
});

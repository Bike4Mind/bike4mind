import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import empty from './__fixtures__/openai/empty.json';
import malformed from './__fixtures__/openai/malformed.json';
import models from './__fixtures__/openai/models.json';
import expected from './__fixtures__/openai/expected.json';
import unknownEnum from './__fixtures__/openai/unknown-enum.json';
import { expectDegradesOnFailure, makeContext, stubFetch, type StubResponse } from './__fixtures__/testSupport';
import {
  createOpenAiSource,
  mergeOpenAiPricing,
  normalizeOpenAiModels,
  OPENAI_MAX_MODEL_DOC_FETCHES,
  OPENAI_MODELS_URL,
} from './openai';
import { OPENAI_PRICING_URL, openAiModelDocUrl } from './openaiDocs';
import type { DiscoveredModel, SourceResult } from '../types';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'openai');
const read = (name: string) => readFileSync(join(fixtures, name), 'utf8');

const pricingMarkdown = read('pricing.md');

/** A listing carrying only the ids a case cares about. */
const listing = (ids: readonly string[]) => ({ data: ids.map(id => ({ id, object: 'model' })) });

/**
 * The route table every pricing case shares: the listing, the pricing page, and a
 * model page per id that has one. Anything else is an unstubbed fetch, which
 * throws - so a case cannot pass by accidentally reading a page it did not mean to.
 */
function routes(options: {
  list?: unknown;
  pricing?: StubResponse;
  modelPages?: Readonly<Record<string, StubResponse>>;
}) {
  const seen: string[] = [];
  const route = (url: string): StubResponse | undefined => {
    seen.push(url);
    if (url === OPENAI_MODELS_URL) return { body: options.list ?? models };
    if (url === OPENAI_PRICING_URL) return options.pricing ?? { raw: pricingMarkdown };
    for (const [modelId, response] of Object.entries(options.modelPages ?? {})) {
      if (url === openAiModelDocUrl(modelId)) return response;
    }
    return undefined;
  };
  return { seen, route };
}

const pricedBy = (result: SourceResult, modelId: string) =>
  result.ok ? result.records.find(record => record.modelId === modelId)?.pricing : undefined;

describe('openai source normalization', () => {
  it('matches the golden file for the captured response', () => {
    expect(normalizeOpenAiModels(models)).toEqual(expected);
  });

  it('never invents a name or a context window it cannot know', () => {
    for (const record of normalizeOpenAiModels(models)) {
      expect(record.patch).not.toHaveProperty('name');
      expect(record.patch).not.toHaveProperty('contextWindow');
    }
  });

  it('skips malformed entries and keeps the rest', () => {
    expect(normalizeOpenAiModels(malformed).map(record => record.modelId)).toEqual(['gpt-5']);
  });

  it('skips an unknown object kind and keeps an unknown owner tier', () => {
    expect(normalizeOpenAiModels(unknownEnum).map(record => record.modelId)).toEqual(['gpt-5', 'gpt-5.7-quantum']);
  });

  it('returns nothing for an empty list rather than inventing rows', () => {
    expect(normalizeOpenAiModels(empty)).toEqual([]);
  });

  it('tolerates a payload that is not a list at all', () => {
    expect(normalizeOpenAiModels(null)).toEqual([]);
    expect(normalizeOpenAiModels({ data: 'nope' })).toEqual([]);
  });
});

describe('openai source fetch', () => {
  it('is configured only when a key is resolved', () => {
    const source = createOpenAiSource();
    expect(source.isConfigured({ openai: 'sk-live' } as never, {})).toBe(true);
    expect(source.isConfigured({ openai: null } as never, {})).toBe(false);
  });

  it('claims authority for the openai backend on a successful listing', async () => {
    const { route } = routes({ modelPages: { 'gpt-5.6-sol': { raw: read('model-gpt-5.6-sol.md') } } });
    const restore = stubFetch(route);
    try {
      const result = await createOpenAiSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.authoritativeFor).toEqual(['openai']);
        expect(result.records).toHaveLength(expected.length);
      }
    } finally {
      restore();
    }
  });

  it('sends the bearer credential to the models endpoint, and no credential to the docs', async () => {
    const seen: Array<{ url: string; auth: unknown }> = [];
    const restore = stubFetch((url, init) => {
      seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      return url === OPENAI_MODELS_URL ? { body: listing(['gpt-5']) } : { raw: pricingMarkdown };
    });
    try {
      await createOpenAiSource().fetch(makeContext());
      expect(seen.map(entry => entry.url)).toEqual([OPENAI_MODELS_URL, OPENAI_PRICING_URL]);
      expect(seen[0].auth).toBe('Bearer test-openai');
      // platform.openai.com is a third-party-shaped read that also follows
      // redirects, so it must never carry the key.
      expect(seen[1].auth).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('fails rather than succeeding empty when the provider lists nothing', async () => {
    const restore = stubFetch({ body: empty });
    try {
      const result = await createOpenAiSource().fetch(makeContext());
      expect(result.ok).toBe(false);
    } finally {
      restore();
    }
  });

  it('fails on a body that is not JSON', async () => {
    const restore = stubFetch({ raw: '<html>gateway</html>' });
    try {
      expect((await createOpenAiSource().fetch(makeContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });

  expectDegradesOnFailure(() => createOpenAiSource());
});

describe('openai source pricing', () => {
  it('prices a flat model straight off the pricing page', async () => {
    const { route } = routes({ list: listing(['gpt-5.4-nano']) });
    const restore = stubFetch(route);
    try {
      const result = await createOpenAiSource().fetch(makeContext());
      expect(pricedBy(result, 'gpt-5.4-nano')).toEqual({
        inputPerMTok: 0.2,
        outputPerMTok: 1.25,
        cacheReadPerMTok: 0.02,
      });
    } finally {
      restore();
    }
  });

  it('reads a model page for the breakpoint its pricing row does not state', async () => {
    const { seen, route } = routes({
      list: listing(['gpt-5.6-luna']),
      modelPages: { 'gpt-5.6-luna': { raw: read('model-gpt-5.6-luna.md') } },
    });
    const restore = stubFetch(route);
    try {
      const result = await createOpenAiSource().fetch(makeContext());
      expect(seen).toContain(openAiModelDocUrl('gpt-5.6-luna'));
      expect(pricedBy(result, 'gpt-5.6-luna')).toEqual({
        inputPerMTok: 0.2,
        outputPerMTok: 1.2,
        cacheReadPerMTok: 0.02,
        cacheWritePerMTok: 0.25,
        brackets: [
          {
            aboveTokens: 272_000,
            inputPerMTok: 0.4,
            outputPerMTok: 1.8,
            cacheReadPerMTok: 0.04,
            cacheWritePerMTok: 0.5,
          },
        ],
      });
    } finally {
      restore();
    }
  });

  it('reads no model page when the pricing row states the breakpoint inline', async () => {
    // gpt-5.5's own cell says "(<272K context length)", so the fan-out has nothing
    // to resolve. A page fetched here would be an unstubbed fetch, which throws.
    const { seen, route } = routes({ list: listing(['gpt-5.5']) });
    const restore = stubFetch(route);
    try {
      const result = await createOpenAiSource().fetch(makeContext());
      expect(seen).toEqual([OPENAI_MODELS_URL, OPENAI_PRICING_URL]);
      expect(pricedBy(result, 'gpt-5.5')).toMatchObject({
        inputPerMTok: 5,
        outputPerMTok: 30,
        brackets: [{ aboveTokens: 272_000, inputPerMTok: 10, outputPerMTok: 45 }],
      });
    } finally {
      restore();
    }
  });

  it('prices nothing at all for a long-context model whose breakpoint it cannot place', async () => {
    // Not the base rates: this source is a provider, so a flat value would win
    // over the aggregators AND block the tiered reprice they can still do between
    // them. Saying nothing leaves the model where it was.
    const { route } = routes({
      list: listing(['gpt-5.6-luna']),
      modelPages: { 'gpt-5.6-luna': { status: 404, raw: 'not found' } },
    });
    const restore = stubFetch(route);
    try {
      const result = await createOpenAiSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      expect(pricedBy(result, 'gpt-5.6-luna')).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('refuses a breakpoint from a page that is not the model it asked for', async () => {
    // The docs request follows redirects, so a soft 404 answers 200 with somebody
    // else's document - and the breakpoint parser takes the first match in
    // whatever it is handed. Serving sol's page for luna must yield no price.
    const { route } = routes({
      list: listing(['gpt-5.6-luna']),
      modelPages: { 'gpt-5.6-luna': { raw: read('model-gpt-5.6-sol.md') } },
    });
    const restore = stubFetch(route);
    try {
      const result = await createOpenAiSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      expect(pricedBy(result, 'gpt-5.6-luna')).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('bounds the model-page fan-out at the cap, whatever the page asks for', async () => {
    // The guard against a restructure that made every row look like it needs a
    // breakpoint. Build a Standard table of long-context rows with no inline
    // annotation, one per listed model, and count the pages actually fetched.
    const many = Array.from({ length: OPENAI_MAX_MODEL_DOC_FETCHES + 8 }, (_unused, index) => `gpt-many-${index}`);
    const table = [
      '### Standard pricing data',
      '',
      '| Model | Short context input | Short context cached input | Short context cache writes |' +
        ' Short context output | Long context input | Long context cached input | Long context cache writes |' +
        ' Long context output |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...many.map(id => `| ${id} | $1.00 | - | - | $2.00 | $2.00 | - | - | $4.00 |`),
      '',
    ].join('\n');

    const { seen, route } = routes({
      list: listing(many),
      pricing: { raw: table },
      modelPages: Object.fromEntries(many.map(id => [id, { raw: read('model-gpt-5.6-luna.md') }])),
    });
    const restore = stubFetch(route);
    try {
      await createOpenAiSource().fetch(makeContext());
      const modelPages = seen.filter(url => url !== OPENAI_MODELS_URL && url !== OPENAI_PRICING_URL);
      expect(modelPages).toHaveLength(OPENAI_MAX_MODEL_DOC_FETCHES);
    } finally {
      restore();
    }
  });

  it('stops the model-page fan-out at the deadline instead of running past it', async () => {
    const { seen, route } = routes({ list: listing(['gpt-5.6-luna']) });
    const restore = stubFetch(route);
    try {
      const result = await createOpenAiSource().fetch(makeContext({ deadlineAt: new Date(Date.now() - 1) }));
      expect(seen).toEqual([OPENAI_MODELS_URL, OPENAI_PRICING_URL]);
      expect(pricedBy(result, 'gpt-5.6-luna')).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('reports the parser row count so a page restructure is caught before it is actioned', async () => {
    const { route } = routes({ list: listing(['gpt-5']) });
    const restore = stubFetch(route);
    try {
      const result = await createOpenAiSource().fetch(makeContext());
      expect(result.ok && result.parserRows).toEqual({ pricing: expect.any(Number) });
    } finally {
      restore();
    }
  });

  it('keeps the availability signal when the pricing page is unreachable', async () => {
    const { route } = routes({ list: listing(['gpt-5']), pricing: { status: 503, raw: 'upstream' } });
    const restore = stubFetch(route);
    try {
      const result = await createOpenAiSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      expect(pricedBy(result, 'gpt-5')).toBeUndefined();
      expect(result.ok && result.parserRows).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('keeps the availability signal when the pricing page restructured', async () => {
    const { route } = routes({ list: listing(['gpt-5']), pricing: { raw: read('parser-broke-pricing.md') } });
    const restore = stubFetch(route);
    try {
      const result = await createOpenAiSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      expect(pricedBy(result, 'gpt-5')).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe('openai pricing merge', () => {
  const record = (modelId: string): DiscoveredModel => ({ modelId, patch: { id: modelId } });

  it('leaves a model the page does not carry exactly as it was', () => {
    const [merged] = mergeOpenAiPricing(
      [record('gpt-9-unlisted')],
      [{ modelId: 'gpt-5', inputPerMTok: 1.25, outputPerMTok: 10 }]
    );
    expect(merged).not.toHaveProperty('pricing');
  });

  it('leaves every model as it was when the page never parsed', () => {
    expect(mergeOpenAiPricing([record('gpt-5')], undefined)).toEqual([record('gpt-5')]);
  });
});

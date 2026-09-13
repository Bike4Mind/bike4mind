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
  OPENAI_MAX_NEW_MODEL_DOC_FETCHES,
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
    expect(normalizeOpenAiModels(models).records).toEqual(expected);
  });

  it('never invents a name or a context window from the listing alone', () => {
    // The listing is four fields wide. A name and a window only ever come from a
    // model's own docs page, and only for an id the catalog does not hold yet
    // (see the new-model docs suite below).
    for (const record of normalizeOpenAiModels(models).records) {
      expect(record.patch).not.toHaveProperty('name');
      expect(record.patch).not.toHaveProperty('contextWindow');
    }
  });

  it('classifies the chat namespaces and still refuses to guess an unknown one', () => {
    const typeOf = (id: string) => normalizeOpenAiModels(listing([id])).records[0]?.patch.type;

    expect(typeOf('gpt-6-astra')).toBe('text');
    expect(typeOf('chatgpt-4o-latest')).toBe('text');
    expect(typeOf('o3-mini')).toBe('text');
    expect(typeOf('codex-mini-latest')).toBe('text');
    // Modality markers still win over the allowlist, or a new image or voice
    // model would be offered as a chat model.
    expect(typeOf('gpt-image-1.5')).toBe('image');
    expect(typeOf('gpt-4o-mini-tts')).toBe('tts');
    expect(typeOf('gpt-realtime')).toBe('realtime-voice');
    // No `type` at all: dropped and counted rather than mislabeled. 'audio' has
    // no member in the enum, and "omni-" is not the o-series.
    expect(typeOf('gpt-4o-audio-preview')).toBeUndefined();
    expect(typeOf('omni-moderation-latest')).toBeUndefined();
    expect(typeOf('babbage-002')).toBeUndefined();
  });

  it('reads the created stamps the listing publishes', () => {
    expect(normalizeOpenAiModels(models).createdAt.get('gpt-5.6-sol')).toBe(1782228018);
    expect(normalizeOpenAiModels(malformed).createdAt.has('')).toBe(false);
    expect(normalizeOpenAiModels(null).createdAt.size).toBe(0);
  });

  it('skips malformed entries and keeps the rest', () => {
    expect(normalizeOpenAiModels(malformed).records.map(record => record.modelId)).toEqual(['gpt-5']);
  });

  it('skips an unknown object kind and keeps an unknown owner tier', () => {
    expect(normalizeOpenAiModels(unknownEnum).records.map(record => record.modelId)).toEqual([
      'gpt-5',
      'gpt-5.7-quantum',
    ]);
  });

  it('returns nothing for an empty list rather than inventing rows', () => {
    expect(normalizeOpenAiModels(empty).records).toEqual([]);
  });

  it('tolerates a payload that is not a list at all', () => {
    expect(normalizeOpenAiModels(null).records).toEqual([]);
    expect(normalizeOpenAiModels({ data: 'nope' }).records).toEqual([]);
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

describe('openai new-model docs', () => {
  /** Every id the catalog holds, as the driver's thunk supplies it. */
  const holding = (...ids: string[]) => ({ knownModelIds: () => new Set(ids) });

  /**
   * A Standard table carrying only the short-context columns, so no row is
   * missing a breakpoint and the PRICING leg fetches no model page at all. That
   * leaves every model-page URL in `seen` attributable to the new-model leg.
   */
  const flatPricing = (ids: readonly string[]) =>
    [
      '### Standard pricing data',
      '',
      '| Model | Short context input | Short context output |',
      '| --- | --- | --- |',
      ...ids.map(id => `| ${id} | $1.00 | $2.00 |`),
      '',
    ].join('\n');

  const modelPages = (urls: readonly string[]) =>
    urls.filter(url => url !== OPENAI_MODELS_URL && url !== OPENAI_PRICING_URL);

  const patchOf = (result: SourceResult, modelId: string) =>
    result.ok ? result.records.find(record => record.modelId === modelId)?.patch : undefined;

  it('emits what a new model page states, and claims no more than that', async () => {
    const { route } = routes({
      list: listing(['gpt-5.6-sol']),
      modelPages: { 'gpt-5.6-sol': { raw: read('model-gpt-5.6-sol.md') } },
    });
    const restore = stubFetch(route);
    try {
      const result = await createOpenAiSource(holding()).fetch(makeContext());

      expect(patchOf(result, 'gpt-5.6-sol')).toEqual({
        id: 'gpt-5.6-sol',
        vendor: 'openai',
        backend: 'openai',
        type: 'text',
        name: 'GPT-5.6 Sol',
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        supportsVision: true,
        // No `style`: that decides how a request builder shapes the call, and no
        // feed may author dispatch.
        reasoning: { supported: true },
      });
    } finally {
      restore();
    }
  });

  it('still invents nothing when the id has no page of its own', async () => {
    const { seen, route } = routes({
      list: listing(['gpt-5.4-nano']),
      pricing: { raw: flatPricing(['gpt-5.4-nano']) },
      modelPages: { 'gpt-5.4-nano': { status: 404, raw: 'not found' } },
    });
    const restore = stubFetch(route);
    try {
      const result = await createOpenAiSource(holding()).fetch(makeContext());

      expect(modelPages(seen)).toEqual([openAiModelDocUrl('gpt-5.4-nano')]);
      expect(patchOf(result, 'gpt-5.4-nano')).not.toHaveProperty('name');
      expect(patchOf(result, 'gpt-5.4-nano')).not.toHaveProperty('contextWindow');
    } finally {
      restore();
    }
  });

  it('refuses a page that is not the model it asked for', async () => {
    // The docs request follows redirects, so a soft 404 answers 200 with somebody
    // else's document - and sol's name and window on luna's row is worse than no
    // row at all.
    const { route } = routes({
      list: listing(['gpt-5.6-luna']),
      modelPages: { 'gpt-5.6-luna': { raw: read('model-gpt-5.6-sol.md') } },
    });
    const restore = stubFetch(route);
    try {
      const result = await createOpenAiSource(holding()).fetch(makeContext());
      expect(patchOf(result, 'gpt-5.6-luna')).not.toHaveProperty('name');
    } finally {
      restore();
    }
  });

  it('reads no page for an id the catalog already holds', async () => {
    // A seeded display name and window belong to the seed, an operator or an
    // aggregator, and a provider claim would outrank all three. A page fetched
    // here is an unstubbed fetch, which throws.
    const { seen, route } = routes({
      list: listing(['gpt-5.4-nano']),
      pricing: { raw: flatPricing(['gpt-5.4-nano']) },
    });
    const restore = stubFetch(route);
    try {
      await createOpenAiSource(holding('gpt-5.4-nano')).fetch(makeContext());
      expect(modelPages(seen)).toEqual([]);
    } finally {
      restore();
    }
  });

  it('reads nothing at all when no driver supplied the known ids', async () => {
    const { seen, route } = routes({
      list: listing(['gpt-5.4-nano']),
      pricing: { raw: flatPricing(['gpt-5.4-nano']) },
    });
    const restore = stubFetch(route);
    try {
      await createOpenAiSource().fetch(makeContext());
      expect(modelPages(seen)).toEqual([]);
    } finally {
      restore();
    }
  });

  it('reads nothing when the driver could not read the catalog', async () => {
    // Undefined is "unknown", not "the catalog is empty": a failed read must not
    // make every listed id look new.
    const { seen, route } = routes({
      list: listing(['gpt-5.4-nano']),
      pricing: { raw: flatPricing(['gpt-5.4-nano']) },
    });
    const restore = stubFetch(route);
    try {
      await createOpenAiSource({ knownModelIds: () => undefined }).fetch(makeContext());
      expect(modelPages(seen)).toEqual([]);
    } finally {
      restore();
    }
  });

  it('spends no fetch on an id that could never be introduced', async () => {
    // A dated snapshot and a fine-tune are refused by planCatalogWrites, an id
    // with no inferable type fails the append schema, and an image or transcribe
    // page states no context window so it can never parse. A page for any of them
    // is a request for a row that cannot exist - and these ids are the NEWEST
    // here, so before they were filtered they took the head of the queue and
    // starved the one id that can yield a row.
    const ids = [
      'gpt-5.9-2026-09-01',
      'ft:gpt-5.4-nano:acme::x1',
      'gpt-4o-audio-preview',
      'gpt-image-9-nova',
      'gpt-9-transcribe',
      'gpt-5.4-nano',
    ];
    const { seen, route } = routes({
      list: { data: ids.map((id, index) => ({ id, object: 'model', created: 1_700_000_100 - index })) },
      pricing: { raw: flatPricing(ids) },
      modelPages: { 'gpt-5.4-nano': { status: 404, raw: 'not found' } },
    });
    const restore = stubFetch(route);
    try {
      await createOpenAiSource(holding()).fetch(makeContext());
      expect(modelPages(seen)).toEqual([openAiModelDocUrl('gpt-5.4-nano')]);
    } finally {
      restore();
    }
  });

  it('reads the newest unknown ids first, up to its own cap', async () => {
    // `created` ascends with the id here, so newest-first is reverse-alphabetical
    // and the two oldest are what falls off the cap. The cap is this leg's own:
    // enriching new models must not cost the pricing legs their pages.
    const count = OPENAI_MAX_NEW_MODEL_DOC_FETCHES + 2;
    const ids = Array.from({ length: count }, (_unused, index) => `gpt-new-${index}`);
    const { seen, route } = routes({
      list: { data: ids.map((id, index) => ({ id, object: 'model', created: 1_700_000_000 + index })) },
      pricing: { raw: flatPricing(ids) },
      modelPages: Object.fromEntries(ids.map(id => [id, { status: 404, raw: 'not found' }])),
    });
    const restore = stubFetch(route);
    try {
      await createOpenAiSource(holding()).fetch(makeContext());

      expect(modelPages(seen)).toEqual(
        ids
          .slice(2)
          .reverse()
          .map(id => openAiModelDocUrl(id))
      );
    } finally {
      restore();
    }
  });

  it('reads no new-model page once the docs budget is spent', async () => {
    const { seen, route } = routes({
      list: listing(['gpt-5.4-nano']),
      pricing: { raw: flatPricing(['gpt-5.4-nano']) },
    });
    const restore = stubFetch(route);
    try {
      await createOpenAiSource(holding()).fetch(makeContext({ deadlineAt: new Date(Date.now() - 1) }));
      expect(modelPages(seen)).toEqual([]);
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

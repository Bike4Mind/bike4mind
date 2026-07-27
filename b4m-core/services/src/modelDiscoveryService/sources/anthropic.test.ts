import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import empty from './__fixtures__/anthropic/empty.json';
import expected from './__fixtures__/anthropic/expected.json';
import malformed from './__fixtures__/anthropic/malformed.json';
import models from './__fixtures__/anthropic/models.json';
import pageTwo from './__fixtures__/anthropic/page-2.json';
import unknownEnum from './__fixtures__/anthropic/unknown-enum.json';
import { expectDegradesOnFailure, makeContext, stubFetch } from './__fixtures__/testSupport';
import {
  ANTHROPIC_MAX_PAGES,
  ANTHROPIC_MODELS_URL,
  createAnthropicSource,
  mergeAnthropicFacts,
  normalizeAnthropicModels,
  pricingSlugFor,
} from './anthropic';
import {
  ANTHROPIC_DEPRECATIONS_URL,
  ANTHROPIC_PRICING_URL,
  parseAnthropicDeprecations,
  parseAnthropicPricing,
  parseLongDate,
  parseModelCell,
  priceInForce,
} from './anthropicDocs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'anthropic');
const read = (name: string) => readFileSync(join(fixtures, name), 'utf8');

const deprecationsMarkdown = read('model-deprecations.md');
const pricingMarkdown = read('pricing.md');
const RUN_AT = new Date('2026-07-26T00:00:00.000Z');

const byId = (pages: readonly unknown[]) => new Map(normalizeAnthropicModels(pages).map(r => [r.modelId, r]));

describe('anthropic model list normalization', () => {
  it('matches the golden file across both pages, with docs facts folded in', () => {
    const lifecycle = parseAnthropicDeprecations(deprecationsMarkdown);
    const pricing = parseAnthropicPricing(pricingMarkdown);
    expect(lifecycle.ok && pricing.ok).toBe(true);
    if (!lifecycle.ok || !pricing.ok) return;

    const merged = mergeAnthropicFacts({
      models: normalizeAnthropicModels([models, pageTwo]),
      lifecycle: lifecycle.rows,
      pricing: pricing.rows,
      at: RUN_AT,
    });
    expect(merged).toEqual(expected);
  });

  it('reads the thinking style off the capabilities tree instead of the model name', () => {
    const list = byId([models]);
    expect(list.get('claude-opus-5')?.patch.reasoning).toEqual({
      supported: true,
      style: 'anthropic-adaptive',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(list.get('claude-sonnet-4-5-20250929')?.patch.reasoning).toEqual({
      supported: true,
      style: 'anthropic-legacy',
    });
    expect(list.get('claude-3-haiku-20240307')?.patch.reasoning).toEqual({ supported: false });
  });

  it('emits no capability fields at all when capabilities is null', () => {
    const record = byId([pageTwo]).get('claude-sonnet-5');
    expect(record?.patch.contextWindow).toBe(1000000);
    expect(record?.patch).not.toHaveProperty('reasoning');
    expect(record?.patch).not.toHaveProperty('supportsVision');
  });

  it('skips malformed entries and keeps the rest', () => {
    const records = normalizeAnthropicModels([malformed]);
    expect(records.map(record => record.modelId)).toEqual(['claude-bad-limits', 'claude-opus-5']);
    const bad = records.find(record => record.modelId === 'claude-bad-limits');
    expect(bad?.patch).not.toHaveProperty('contextWindow');
    expect(bad?.patch).not.toHaveProperty('maxOutputTokens');
  });

  it('keeps an unknown capability leaf out of the patch and skips an unknown object type', () => {
    const records = normalizeAnthropicModels([unknownEnum]);
    expect(records.map(record => record.modelId)).toEqual(['claude-opus-6']);
    expect(records[0]?.patch).not.toHaveProperty('video_input');
    // An effort level this build does not know is dropped, not passed through.
    expect(records[0]?.patch.reasoning?.effortLevels).toEqual(['low', 'high']);
  });

  it('returns nothing for an empty page', () => {
    expect(normalizeAnthropicModels([empty])).toEqual([]);
  });
});

describe('anthropic deprecations parser', () => {
  it('reads the model status table from the live page', () => {
    const parsed = parseAnthropicDeprecations(deprecationsMarkdown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const byModel = new Map(parsed.rows.map(row => [row.modelId, row]));
    expect(byModel.get('claude-opus-5')).toEqual({
      modelId: 'claude-opus-5',
      status: 'active',
      deprecationDate: undefined,
      retirementDate: undefined,
      replacedBy: undefined,
    });
    expect(byModel.get('claude-opus-4-1-20250805')).toEqual({
      modelId: 'claude-opus-4-1-20250805',
      status: 'deprecated',
      deprecationDate: '2026-06-05',
      retirementDate: '2026-08-05',
      replacedBy: 'claude-opus-4-8',
    });
    expect(byModel.get('claude-3-7-sonnet-20250219')?.status).toBe('retired');
  });

  it('does not turn "Not sooner than <date>" into a retirement date for an active model', () => {
    const parsed = parseAnthropicDeprecations(deprecationsMarkdown);
    if (!parsed.ok) throw new Error('parser failed');
    for (const row of parsed.rows.filter(candidate => candidate.status === 'active')) {
      expect(row.retirementDate).toBeUndefined();
    }
  });

  it('returns a failure, never an empty success, when the table renders with zero rows', () => {
    const parsed = parseAnthropicDeprecations(read('parser-broke-deprecations.md'));
    expect(parsed.ok).toBe(false);
  });

  it('returns a failure when the page has no table it recognizes', () => {
    expect(parseAnthropicDeprecations('# Model deprecations\n\nSee the console.\n').ok).toBe(false);
  });

  it('parses long dates and rejects N/A', () => {
    expect(parseLongDate('June 9, 2027')).toBe('2027-06-09');
    expect(parseLongDate('Not sooner than November 24, 2026')).toBe('2026-11-24');
    expect(parseLongDate('N/A')).toBeUndefined();
  });
});

describe('anthropic pricing parser', () => {
  const parsed = parseAnthropicPricing(pricingMarkdown);

  it('reads the model pricing table and not the batch table', () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const opus5 = parsed.rows.find(row => row.slug === 'claude-opus-5');
    // Batch pricing for Opus 5 is half of this; picking that table would show 2.50.
    expect(opus5).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 });
  });

  it('slugs a display name with an annotation down to the id shape', () => {
    expect(parseModelCell('Claude Opus 4.1 ([deprecated](/docs/en/about-claude/model-deprecations))')).toEqual({
      slug: 'claude-opus-4-1',
      validUntil: undefined,
      validFrom: undefined,
    });
    expect(parseModelCell('Claude Mythos 5 ([limited availability](https://anthropic.com/glasswing))')?.slug).toBe(
      'claude-mythos-5'
    );
  });

  it('keeps both halves of a time-boxed rate and picks by the run clock', () => {
    if (!parsed.ok) throw new Error('parser failed');
    const boxed = parsed.rows.filter(row => row.slug === 'claude-sonnet-5');
    expect(boxed).toHaveLength(2);

    const intro = priceInForce(parsed.rows, 'claude-sonnet-5', new Date('2026-07-26T00:00:00Z'));
    expect(intro).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10, validUntil: '2026-08-31' });

    const standard = priceInForce(parsed.rows, 'claude-sonnet-5', new Date('2026-09-01T00:00:00Z'));
    expect(standard).toMatchObject({ inputPerMTok: 3, outputPerMTok: 15, validFrom: '2026-09-01' });
  });

  it('maps a dated model id onto the undated docs slug', () => {
    expect(pricingSlugFor('claude-opus-4-5-20251101')).toBe('claude-opus-4-5');
    expect(pricingSlugFor('claude-opus-5')).toBe('claude-opus-5');
  });

  it('returns a failure, never an empty success, when no row carries a rate', () => {
    expect(parseAnthropicPricing(read('parser-broke-pricing.md')).ok).toBe(false);
  });

  it('returns a failure when the pricing table is gone', () => {
    expect(parseAnthropicPricing('# Pricing\n\nContact sales.\n').ok).toBe(false);
  });
});

describe('anthropic source fetch', () => {
  const route = (url: string) => {
    if (url.startsWith(ANTHROPIC_MODELS_URL)) {
      return { body: url.includes('after_id') ? pageTwo : models };
    }
    if (url === ANTHROPIC_DEPRECATIONS_URL) return { raw: deprecationsMarkdown };
    if (url === ANTHROPIC_PRICING_URL) return { raw: pricingMarkdown };
    return undefined;
  };

  it('is configured only when a key is resolved', () => {
    const source = createAnthropicSource();
    expect(source.isConfigured({ anthropic: 'sk-ant' } as never, {})).toBe(true);
    expect(source.isConfigured({ anthropic: null } as never, {})).toBe(false);
  });

  it('paginates on last_id and claims authority for the anthropic backend', async () => {
    const calls: string[] = [];
    const restore = stubFetch(url => {
      calls.push(url);
      return route(url);
    });
    try {
      const result = await createAnthropicSource().fetch(makeContext({ runStartedAt: RUN_AT }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.authoritativeFor).toEqual(['anthropic']);
        expect(result.records.map(record => record.modelId)).toContain('claude-sonnet-5');
      }
      expect(calls.filter(url => url.startsWith(ANTHROPIC_MODELS_URL))).toHaveLength(2);
      expect(calls[1]).toContain('after_id=claude-3-haiku-20240307');
    } finally {
      restore();
    }
  });

  it('reports a row count per docs parser, and only for the ones that ran', async () => {
    const restore = stubFetch(url => route(url));
    try {
      const result = await createAnthropicSource().fetch(makeContext({ runStartedAt: RUN_AT }));
      expect(result.ok && result.parserRows).toEqual({ deprecations: expect.any(Number), pricing: expect.any(Number) });
    } finally {
      restore();
    }

    const withoutDeprecations = stubFetch(url =>
      url === ANTHROPIC_DEPRECATIONS_URL ? { status: 500, body: {} } : route(url)
    );
    try {
      const result = await createAnthropicSource().fetch(makeContext({ runStartedAt: RUN_AT }));
      // A page that never parsed has no count: comparing against a missing one
      // would read as a 100% move on the next run.
      expect(result.ok && result.parserRows && 'deprecations' in result.parserRows).toBe(false);
    } finally {
      withoutDeprecations();
    }
  });

  it('bounds pagination when has_more never goes false', async () => {
    let pages = 0;
    const restore = stubFetch(url => {
      if (!url.startsWith(ANTHROPIC_MODELS_URL)) return route(url);
      pages += 1;
      return { body: { ...models, last_id: `cursor-${pages}` } };
    });
    try {
      await createAnthropicSource().fetch(makeContext({ runStartedAt: RUN_AT }));
      expect(pages).toBe(ANTHROPIC_MAX_PAGES);
    } finally {
      restore();
    }
  });

  it('keeps the availability signal when a docs page is unreachable', async () => {
    const restore = stubFetch(url =>
      url === ANTHROPIC_DEPRECATIONS_URL || url === ANTHROPIC_PRICING_URL ? { status: 500, body: {} } : route(url)
    );
    try {
      const result = await createAnthropicSource().fetch(makeContext({ runStartedAt: RUN_AT }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.records.length).toBeGreaterThan(0);
        // The field group the broken page owns falls through rather than being cleared.
        expect(result.records.every(record => record.patch.lifecycle === undefined)).toBe(true);
        expect(result.records.every(record => record.pricing === undefined)).toBe(true);
      }
    } finally {
      restore();
    }
  });

  it('keeps the availability signal when a docs page parses to zero rows', async () => {
    const restore = stubFetch(url => {
      if (url === ANTHROPIC_DEPRECATIONS_URL) return { raw: read('parser-broke-deprecations.md') };
      return route(url);
    });
    try {
      const result = await createAnthropicSource().fetch(makeContext({ runStartedAt: RUN_AT }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.records.every(record => record.patch.lifecycle === undefined)).toBe(true);
    } finally {
      restore();
    }
  });

  it('fails rather than succeeding empty when the model list is empty', async () => {
    const restore = stubFetch(url => (url.startsWith(ANTHROPIC_MODELS_URL) ? { body: empty } : route(url)));
    try {
      expect((await createAnthropicSource().fetch(makeContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });

  expectDegradesOnFailure(() => createAnthropicSource());
});

import { describe, expect, it } from 'vitest';
import empty from './__fixtures__/gemini/empty.json';
import expected from './__fixtures__/gemini/expected.json';
import malformed from './__fixtures__/gemini/malformed.json';
import pageOne from './__fixtures__/gemini/page-1.json';
import pageTwo from './__fixtures__/gemini/page-2.json';
import unknownEnum from './__fixtures__/gemini/unknown-enum.json';
import { expectDegradesOnFailure, makeContext, stubFetch } from './__fixtures__/testSupport';
import { createGeminiSource, GEMINI_MAX_PAGES, GEMINI_PAGE_SIZE, normalizeGeminiModels } from './gemini';

const byId = (pages: readonly unknown[]) => new Map(normalizeGeminiModels(pages).map(r => [r.modelId, r]));

describe('gemini normalization', () => {
  it('matches the golden file for both pages', () => {
    expect(normalizeGeminiModels([pageOne, pageTwo])).toEqual(expected);
  });

  it('strips the models/ resource prefix from the id', () => {
    expect(byId([pageOne]).has('gemini-2.5-pro')).toBe(true);
    expect(byId([pageOne]).has('models/gemini-2.5-pro')).toBe(false);
  });

  it('carries the max output tokens no other provider publishes', () => {
    expect(byId([pageOne]).get('gemini-2.5-pro')?.patch.maxOutputTokens).toBe(65536);
  });

  it('classifies by generation method first and id namespace second', () => {
    const models = byId([pageOne, pageTwo]);
    expect(models.get('gemini-2.5-pro')?.patch.type).toBe('text');
    expect(models.get('gemini-embedding-001')?.patch.type).toBe('embedding');
    expect(models.get('gemini-3.1-flash-image')?.patch.type).toBe('image');
    expect(models.get('veo-3.1-generate-preview')?.patch.type).toBe('video');
    expect(models.get('gemini-2.5-flash-preview-tts')?.patch.type).toBe('tts');
    expect(models.get('gemini-3.1-flash-live-preview')?.patch.type).toBe('realtime-voice');
  });

  it('never emits the presentation-owned description', () => {
    for (const record of normalizeGeminiModels([pageOne, pageTwo])) {
      expect(record.patch).not.toHaveProperty('description');
    }
  });

  it('skips malformed entries and keeps the rest', () => {
    const records = normalizeGeminiModels([malformed]);
    expect(records.map(record => record.modelId)).toEqual(['gemini-2.5-pro', 'gemini-bad-limits']);
    const bad = records.find(record => record.modelId === 'gemini-bad-limits');
    expect(bad?.patch).not.toHaveProperty('contextWindow');
    expect(bad?.patch).not.toHaveProperty('maxOutputTokens');
    expect(bad?.patch).not.toHaveProperty('canStream');
  });

  it('tolerates an unknown generation method', () => {
    const records = normalizeGeminiModels([unknownEnum]);
    expect(records).toHaveLength(1);
    expect(records[0]?.patch.type).toBe('text');
  });

  it('returns nothing for an empty page', () => {
    expect(normalizeGeminiModels([empty])).toEqual([]);
  });
});

describe('gemini pagination', () => {
  const pageUrls = (calls: string[]) => calls.map(url => new URL(url));

  it('walks two pages with pageSize=1000 and concatenates them', async () => {
    const calls: string[] = [];
    const restore = stubFetch(url => {
      calls.push(url);
      return { body: calls.length === 1 ? pageOne : pageTwo };
    });
    try {
      const result = await createGeminiSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.records).toHaveLength(expected.length);

      const [first, second] = pageUrls(calls);
      expect(calls).toHaveLength(2);
      expect(first?.searchParams.get('pageSize')).toBe(String(GEMINI_PAGE_SIZE));
      expect(first?.searchParams.get('pageToken')).toBeNull();
      expect(second?.searchParams.get('pageToken')).toBe(pageOne.nextPageToken);
    } finally {
      restore();
    }
  });

  it('sends the key as a header, never in the query string', async () => {
    const calls: string[] = [];
    const restore = stubFetch(url => {
      calls.push(url);
      return { body: pageTwo };
    });
    try {
      await createGeminiSource().fetch(makeContext());
      expect(calls[0]).not.toContain('key=');
    } finally {
      restore();
    }
  });

  it('bounds the loop when the server keeps handing out fresh tokens', async () => {
    let issued = 0;
    const restore = stubFetch(() => {
      issued += 1;
      return { body: { ...pageOne, nextPageToken: `token-${issued}` } };
    });
    try {
      const result = await createGeminiSource().fetch(makeContext());
      expect(issued).toBe(GEMINI_MAX_PAGES);
      expect(result.ok).toBe(true);
    } finally {
      restore();
    }
  });

  it('stops when the server repeats a token instead of looping forever', async () => {
    let issued = 0;
    const restore = stubFetch(() => {
      issued += 1;
      return { body: { ...pageOne, nextPageToken: 'same-token' } };
    });
    try {
      await createGeminiSource().fetch(makeContext());
      expect(issued).toBe(2);
    } finally {
      restore();
    }
  });

  it('fails rather than half-listing when the budget runs out mid-pagination', async () => {
    const restore = stubFetch({ body: pageOne });
    try {
      const result = await createGeminiSource().fetch(makeContext({ deadlineAt: new Date(Date.now() - 1) }));
      expect(result.ok).toBe(false);
    } finally {
      restore();
    }
  });

  it('fails when a later page errors, rather than committing the earlier ones', async () => {
    let call = 0;
    const restore = stubFetch(() => {
      call += 1;
      return call === 1 ? { body: pageOne } : { status: 500, body: {} };
    });
    try {
      expect((await createGeminiSource().fetch(makeContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('gemini source fetch', () => {
  it('is configured only when a key is resolved', () => {
    const source = createGeminiSource();
    expect(source.isConfigured({ gemini: 'live' } as never, {})).toBe(true);
    expect(source.isConfigured({ gemini: null } as never, {})).toBe(false);
  });

  it('claims authority for the gemini backend', async () => {
    const restore = stubFetch({ body: pageTwo });
    try {
      const result = await createGeminiSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.authoritativeFor).toEqual(['gemini']);
    } finally {
      restore();
    }
  });

  it('fails rather than succeeding empty', async () => {
    const restore = stubFetch({ body: empty });
    try {
      expect((await createGeminiSource().fetch(makeContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });

  expectDegradesOnFailure(() => createGeminiSource());
});

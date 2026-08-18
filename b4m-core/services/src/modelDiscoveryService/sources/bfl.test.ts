import { describe, expect, it } from 'vitest';
import empty from './__fixtures__/bfl/empty.json';
import expected from './__fixtures__/bfl/expected.json';
import malformed from './__fixtures__/bfl/malformed.json';
import openapi from './__fixtures__/bfl/openapi.json';
import unknownEnum from './__fixtures__/bfl/unknown-enum.json';
import { expectDegradesOnFailure, makeContext, stubFetch } from './__fixtures__/testSupport';
import { BFL_OPENAPI_URL, createBflSource, normalizeBflOpenApi } from './bfl';

const byId = (payload: unknown) => new Map(normalizeBflOpenApi(payload).map(record => [record.modelId, record]));

describe('bfl openapi normalization', () => {
  it('matches the golden file for the captured document', () => {
    expect(normalizeBflOpenApi(openapi)).toEqual(expected);
  });

  it('treats a prompt-taking POST path as a model and nothing else', () => {
    const ids = [...byId(openapi).keys()];
    expect(ids).toContain('flux-pro-1.1');
    expect(ids).toContain('flux-2-pro');
    expect(ids).toContain('flux-tools/vto-v2');
    // Account plumbing, GET-only endpoints, and a prompt-less image tool.
    expect(ids).not.toContain('credits');
    expect(ids).not.toContain('get_result');
    expect(ids).not.toContain('delete_finetune');
    expect(ids).not.toContain('flux-tools/erase-v1');
  });

  it('reads the option flags off the request schema', () => {
    const kontext = byId(openapi).get('flux-kontext-pro');
    expect(kontext?.patch).toMatchObject({ supportsImageVariation: true, supportsSafetyTolerance: true });

    const dev = byId(openapi).get('flux-dev');
    expect(dev?.patch.supportsSafetyTolerance).toBe(true);
  });

  it('skips a dangling $ref and a path outside /v1/', () => {
    const ids = [...byId(malformed).keys()];
    expect(ids).toEqual(['flux-pro-1.1']);
  });

  it('tolerates option values this build does not know', () => {
    const record = normalizeBflOpenApi(unknownEnum)[0];
    expect(record?.modelId).toBe('flux-3-holo');
    expect(record?.patch).not.toHaveProperty('render_mode');
    expect(record?.patch.supportsImageVariation).toBe(true);
  });

  it('never invents a display name, because the catalog curates FLUX names', () => {
    for (const record of normalizeBflOpenApi(openapi)) {
      expect(record.patch).not.toHaveProperty('name');
    }
  });

  it('returns nothing for a document with no paths', () => {
    expect(normalizeBflOpenApi(empty)).toEqual([]);
    expect(normalizeBflOpenApi(null)).toEqual([]);
  });
});

describe('bfl source fetch', () => {
  it('needs a key even though the document is public, since the models are not', () => {
    const source = createBflSource();
    expect(source.isConfigured({ bfl: 'bfl-live' } as never, {})).toBe(true);
    expect(source.isConfigured({ bfl: null } as never, {})).toBe(false);
  });

  it('claims authority for the bfl backend', async () => {
    const calls: string[] = [];
    const restore = stubFetch(url => {
      calls.push(url);
      return { body: openapi };
    });
    try {
      const result = await createBflSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.authoritativeFor).toEqual(['bfl']);
      expect(calls).toEqual([BFL_OPENAPI_URL]);
    } finally {
      restore();
    }
  });

  it('fails on a restructured document rather than retiring every FLUX model', async () => {
    const restore = stubFetch({ body: empty });
    try {
      expect((await createBflSource().fetch(makeContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });

  expectDegradesOnFailure(() => createBflSource());
});

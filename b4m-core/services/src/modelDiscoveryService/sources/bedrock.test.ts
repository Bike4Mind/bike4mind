import { describe, expect, it, vi } from 'vitest';
import availabilityFixture from './__fixtures__/bedrock/availability.json';
import empty from './__fixtures__/bedrock/empty.json';
import expected from './__fixtures__/bedrock/expected.json';
import listResponse from './__fixtures__/bedrock/list-foundation-models.json';
import malformed from './__fixtures__/bedrock/malformed.json';
import unknownEnum from './__fixtures__/bedrock/unknown-enum.json';
import { abortedContext, makeContext } from './__fixtures__/testSupport';
import {
  BEDROCK_AVAILABILITY_CONCURRENCY,
  createBedrockSource,
  normalizeBedrockModels,
  type BedrockAvailability,
  type BedrockControlPlane,
  type BedrockFoundationModelSummary,
} from './bedrock';

const summaries = listResponse.modelSummaries as BedrockFoundationModelSummary[];
const availability = new Map<string, BedrockAvailability>(Object.entries(availabilityFixture));
const byId = (facts: Parameters<typeof normalizeBedrockModels>[0]) =>
  new Map(normalizeBedrockModels(facts).map(record => [record.modelId, record]));

function fakeClient(overrides: Partial<BedrockControlPlane> = {}): BedrockControlPlane {
  return {
    listFoundationModels: async () => summaries,
    getFoundationModelAvailability: async (modelId: string) => availability.get(modelId) ?? null,
    ...overrides,
  };
}

describe('bedrock normalization', () => {
  it('matches the golden file', () => {
    expect(normalizeBedrockModels({ summaries, availability })).toEqual(expected);
  });

  it('maps the typed lifecycle onto the catalog lifecycle, dates and all', () => {
    const legacy = byId({ summaries }).get('anthropic.claude-3-haiku-20240307-v1:0');
    expect(legacy?.patch.lifecycle).toEqual({
      status: 'legacy',
      deprecationDate: '2026-02-19',
      retirementDate: '2026-04-20',
    });
    expect(byId({ summaries }).get('meta.llama4-scout-17b-instruct-v1:0')?.patch.lifecycle).toEqual({
      status: 'active',
    });
    // Marked typed, which is what lets it transition on the first run instead of
    // being held back as a suggestion.
    expect(legacy?.lifecycleEvidence).toBe('typed');
  });

  it('accepts a Date as readily as an ISO string, so a queued response still parses', () => {
    const withDates = normalizeBedrockModels({
      summaries: [
        {
          modelId: 'anthropic.claude-x-v1:0',
          modelLifecycle: { status: 'LEGACY', legacyTime: new Date('2026-02-19T00:00:00Z') },
        },
      ],
    });
    expect(withDates[0]?.patch.lifecycle?.deprecationDate).toBe('2026-02-19');
  });

  it('never publishes a context window Bedrock does not have', () => {
    for (const record of normalizeBedrockModels({ summaries })) {
      expect(record.patch).not.toHaveProperty('contextWindow');
    }
  });

  it('reads the model kind off the output modality', () => {
    const models = byId({ summaries });
    expect(models.get('anthropic.claude-opus-4-5-20251101-v1:0')?.patch.type).toBe('text');
    expect(models.get('amazon.nova-canvas-v1:0')?.patch.type).toBe('image');
    expect(models.get('amazon.titan-embed-text-v2:0')?.patch.type).toBe('embedding');
  });

  it('disables an unentitled model and leaves an unchecked one alone', () => {
    const models = byId({ summaries, availability });
    expect(models.get('meta.llama4-scout-17b-instruct-v1:0')?.patch).toMatchObject({
      autoDisabled: true,
      autoDisabledReason: 'not entitled in this AWS account',
    });
    expect(models.get('anthropic.claude-opus-4-5-20251101-v1:0')?.patch).not.toHaveProperty('autoDisabled');
    // Never asked about: absence of data must not read as absence of entitlement.
    expect(models.get('amazon.nova-canvas-v1:0')?.patch).not.toHaveProperty('autoDisabled');
  });

  it('skips malformed entries and drops an unparseable lifecycle date', () => {
    const records = normalizeBedrockModels({ summaries: malformed.modelSummaries as BedrockFoundationModelSummary[] });
    expect(records.map(record => record.modelId)).toEqual([
      'anthropic.claude-opus-4-5-20251101-v1:0',
      'vendor.broken-v1:0',
    ]);
    expect(records[1]?.patch.lifecycle).toEqual({ status: 'legacy' });
  });

  it('ignores a lifecycle status this build has never seen rather than guessing at it', () => {
    const record = normalizeBedrockModels({
      summaries: unknownEnum.modelSummaries as BedrockFoundationModelSummary[],
    })[0];
    expect(record?.patch).not.toHaveProperty('lifecycle');
    expect(record?.patch.type).toBe('text');
    expect(record?.patch.supportsVision).toBe(true);
  });

  it('returns nothing for an empty listing', () => {
    expect(normalizeBedrockModels({ summaries: empty.modelSummaries })).toEqual([]);
  });
});

describe('bedrock source fetch', () => {
  it('is configured on IAM alone, and refused when self-host makes those credentials local', () => {
    const source = createBedrockSource({ client: fakeClient() });
    expect(source.isConfigured({ awsIam: true } as never, {})).toBe(true);
    expect(source.isConfigured({ awsIam: false } as never, {})).toBe(false);
  });

  it('claims authority for the bedrock backend', async () => {
    const result = await createBedrockSource({ client: fakeClient() }).fetch(makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.authoritativeFor).toEqual(['bedrock']);
  });

  it('only asks about models the catalog does not already hold as active', async () => {
    const asked: string[] = [];
    const client = fakeClient({
      getFoundationModelAvailability: async (modelId: string) => {
        asked.push(modelId);
        return availability.get(modelId) ?? null;
      },
    });
    const activeModelIds = () =>
      new Set(['anthropic.claude-opus-4-5-20251101-v1:0', 'anthropic.claude-3-haiku-20240307-v1:0']);

    await createBedrockSource({ client, activeModelIds }).fetch(makeContext());
    expect(asked.sort()).toEqual([
      'amazon.nova-canvas-v1:0',
      'amazon.titan-embed-text-v2:0',
      'meta.llama4-scout-17b-instruct-v1:0',
    ]);
  });

  it('bounds concurrency so 300 models do not become 300 simultaneous calls', async () => {
    let inFlight = 0;
    let peak = 0;
    const many = Array.from({ length: 40 }, (_unused, index) => ({ modelId: `vendor.model-${index}-v1:0` }));
    const client = fakeClient({
      listFoundationModels: async () => many,
      getFoundationModelAvailability: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 1));
        inFlight -= 1;
        return null;
      },
    });

    await createBedrockSource({ client }).fetch(makeContext());
    expect(peak).toBeLessThanOrEqual(BEDROCK_AVAILABILITY_CONCURRENCY);
  });

  it('treats a per-model availability failure as no data, never as unavailable', async () => {
    const client = fakeClient({
      getFoundationModelAvailability: async () => {
        throw new Error('ThrottlingException');
      },
    });
    const result = await createBedrockSource({ client }).fetch(makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toHaveLength(summaries.length);
      expect(result.records.every(record => record.patch.autoDisabled === undefined)).toBe(true);
    }
  });

  it('stops issuing availability calls once the deadline aborts', async () => {
    const asked = vi.fn(async () => null);
    const client = fakeClient({ getFoundationModelAvailability: asked });
    const result = await createBedrockSource({ client }).fetch(abortedContext());
    expect(asked).not.toHaveBeenCalled();
    // The listing itself still succeeded, so the run keeps what it verified.
    expect(result.ok).toBe(true);
  });

  it('fails when the listing throws, rather than reporting an empty backend', async () => {
    const client = fakeClient({
      listFoundationModels: async () => {
        throw new Error('AccessDeniedException');
      },
    });
    const result = await createBedrockSource({ client }).fetch(makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('AccessDeniedException');
  });

  it('fails when the control plane cannot be constructed at all', async () => {
    const result = await createBedrockSource({
      client: () => {
        throw new Error('@aws-sdk/client-bedrock is not installed');
      },
    }).fetch(makeContext());
    expect(result.ok).toBe(false);
  });

  it('fails rather than succeeding empty', async () => {
    const client = fakeClient({ listFoundationModels: async () => [] });
    expect((await createBedrockSource({ client }).fetch(makeContext())).ok).toBe(false);
  });
});

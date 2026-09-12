// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// serverConfig.ts builds its API handler at module load, so stub the middleware and the
// heavy DB/service deps; the two compute* helpers are thin delegations this test verifies.
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ get: (fn: unknown) => fn }) }));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/utils/config', () => ({ Config: {} }));
vi.mock('sst', () => ({ Resource: {} }));

vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: { name: 'apiKeys' },
  adminSettingsRepository: { name: 'adminSettings' },
}));

const resolveToolAvailability = vi.fn().mockResolvedValue({ weather_info: true });
const getEffectiveLLMApiKeys = vi.fn();
vi.mock('@bike4mind/services', () => ({
  resolveToolAvailability: (...a: unknown[]) => resolveToolAvailability(...a),
  isLocalImageBackendAvailable: vi.fn(),
  isLocalEmbedderAvailable: vi.fn(),
  apiKeyService: { getEffectiveLLMApiKeys: (...a: unknown[]) => getEffectiveLLMApiKeys(...a) },
}));

vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: { name: 'getSettingsByNames' } }));

// The resolution rule itself is pinned in server/embeddings/effectiveEmbeddingModel.test.ts; what
// belongs here is only how this route adapts it for the wire.
const resolveEffectiveEmbeddingModel = vi.fn();
vi.mock('@server/embeddings/effectiveEmbeddingModel', () => ({
  resolveEffectiveEmbeddingModel: (...a: unknown[]) => resolveEffectiveEmbeddingModel(...a),
}));

import { computeToolAvailability, computeEffectiveEmbeddingModel } from '../serverConfig';

beforeEach(() => {
  vi.clearAllMocks();
  resolveToolAvailability.mockResolvedValue({ weather_info: true });
});

describe('computeToolAvailability (thin wrapper over resolveToolAvailability)', () => {
  it('delegates to resolveToolAvailability with the apiKeys/adminSettings repos and returns its result', async () => {
    const result = await computeToolAvailability('user-1');

    expect(resolveToolAvailability).toHaveBeenCalledWith(
      'user-1',
      { db: { apiKeys: { name: 'apiKeys' }, adminSettings: { name: 'adminSettings' } } },
      {}
    );
    expect(result).toEqual({ weather_info: true });
  });

  it('passes userId through unchanged, including undefined for an anonymous request', async () => {
    await computeToolAvailability(undefined);
    expect(resolveToolAvailability).toHaveBeenCalledWith(undefined, expect.anything(), {});
  });

  it('forwards an injected key table so the route resolves it only once per request', async () => {
    // This route is hit on every page load and both computations need the same table; without the
    // injection each ran its own findByUserIdAndTypes for an identical answer.
    await computeToolAvailability('user-1', { openai: 'sk-live' });

    expect(resolveToolAvailability).toHaveBeenCalledWith('user-1', expect.anything(), {
      llmKeys: { openai: 'sk-live' },
    });
  });

  it('omits llmKeys entirely when none is injected, rather than passing undefined', async () => {
    // `resolveToolAvailability` reads the key's PRESENCE, so passing `{ llmKeys: undefined }` would
    // read as an injected empty table and hide every key-gated tool.
    await computeToolAvailability('user-1');

    expect(resolveToolAvailability.mock.calls[0][2]).not.toHaveProperty('llmKeys');
  });

  it('omits a nullish table too, so a failed route lookup cannot flip fail-open to fail-closed', async () => {
    // The route resolves the key table once and shares it. When that lookup throws there is nothing
    // to share, and injecting the failure is not neutral: `resolveToolAvailability` documents that
    // an injected value cannot be tainted, so it would be treated as an authoritative empty table
    // and every key-gated tool would vanish from the picker - the exact opposite of the fail-open
    // policy this wrapper exists to apply.
    await computeToolAvailability('user-1', null as unknown as undefined);

    expect(resolveToolAvailability.mock.calls[0][2]).not.toHaveProperty('llmKeys');
  });
});

describe('computeEffectiveEmbeddingModel (wire adapter over the shared resolver)', () => {
  it("returns the resolved model, and '' for the resolver's unknown", async () => {
    resolveEffectiveEmbeddingModel.mockResolvedValue('amazon.titan-embed-text-v2:0');
    expect(await computeEffectiveEmbeddingModel('user-1')).toBe('amazon.titan-embed-text-v2:0');

    // '' is the wire form of unknown: the field is a required string on ServerConfig, and the
    // client reads a falsy value as "suppress the comparison" rather than falling back to the
    // advertised setting - which is the substitution this whole field exists to remove.
    resolveEffectiveEmbeddingModel.mockResolvedValue(undefined);
    expect(await computeEffectiveEmbeddingModel('user-1')).toBe('');
  });

  it('forwards an injected key table, and omits it when there is none', async () => {
    resolveEffectiveEmbeddingModel.mockResolvedValue('text-embedding-ada-002');

    await computeEffectiveEmbeddingModel('user-1', { openai: 'sk-live' });
    expect(resolveEffectiveEmbeddingModel).toHaveBeenCalledWith('user-1', { llmKeys: { openai: 'sk-live' } });

    await computeEffectiveEmbeddingModel('user-1');
    expect(resolveEffectiveEmbeddingModel).toHaveBeenLastCalledWith('user-1', {});
  });

  it("omits a nullish table rather than forwarding the route's failed lookup as an answer", async () => {
    // The regression this pins. An injected table is read as authoritative, and a nullish one reads
    // as "this caller holds no credential" - which makes the resolver SUBSTITUTE and report a
    // confident keyless Titan on a fully keyed stage, reddening a mismatch badge across an entire
    // healthy library. The route now catches to `undefined`, which means "not injected", so the
    // resolver runs its own lookup and degrades the way it does for every other caller.
    resolveEffectiveEmbeddingModel.mockResolvedValue(undefined);

    await computeEffectiveEmbeddingModel('user-1', null as unknown as undefined);

    expect(resolveEffectiveEmbeddingModel).toHaveBeenCalledWith('user-1', {});
  });
});

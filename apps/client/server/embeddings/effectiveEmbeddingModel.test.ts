import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSettingsValue = vi.fn();
vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: { name: 'apiKeys' },
  adminSettingsRepository: { name: 'adminSettings', getSettingsValue: (...a: unknown[]) => getSettingsValue(...a) },
}));

const getEffectiveLLMApiKeys = vi.fn();
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: (...a: unknown[]) => getEffectiveLLMApiKeys(...a) },
}));

const resolveEmbeddingWithKeylessFallback = vi.fn();
vi.mock('@bike4mind/utils', () => ({
  getSettingsByNames: { name: 'getSettingsByNames' },
  resolveEmbeddingWithKeylessFallback: (...a: unknown[]) => resolveEmbeddingWithKeylessFallback(...a),
}));

import { resolveEffectiveEmbeddingModel } from './effectiveEmbeddingModel';

const TITAN = 'amazon.titan-embed-text-v2:0';
const ADA = 'text-embedding-ada-002';

/**
 * Two callers depend on this answer and both fail SILENTLY when it is wrong, in opposite ways:
 * /api/settings/serverConfig hands it to the client, where a wrong value reddens a mismatch badge
 * on an entire library of healthy files; lakeMemoryRecall hands it to `isFabFileCitable`, where a
 * wrong value drops every citation and lake-memory recall returns nothing at all. Neither logs an
 * error in that state, which is why the unresolvable cases are pinned here individually.
 */
describe('resolveEffectiveEmbeddingModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-live' });
  });

  it('returns the model the credential seam settled on, not the configured one', async () => {
    getSettingsValue.mockResolvedValue(ADA);
    resolveEmbeddingWithKeylessFallback.mockReturnValue({ model: TITAN, missing: null, config: {} });

    expect(await resolveEffectiveEmbeddingModel('user-1')).toBe(TITAN);
  });

  it('resolves against the CALLER key table, so a personal key is honoured as ingest honours it', async () => {
    getSettingsValue.mockResolvedValue(ADA);
    resolveEmbeddingWithKeylessFallback.mockReturnValue({ model: ADA, missing: null, config: {} });

    await resolveEffectiveEmbeddingModel('user-1');

    expect(getEffectiveLLMApiKeys).toHaveBeenCalledWith('user-1', expect.anything());
    expect(resolveEmbeddingWithKeylessFallback).toHaveBeenCalledWith(ADA, { openai: 'sk-live' });
  });

  it('returns the configured model unchanged when this stage holds its credential', async () => {
    getSettingsValue.mockResolvedValue(ADA);
    resolveEmbeddingWithKeylessFallback.mockReturnValue({ model: ADA, missing: null, config: {} });

    expect(await resolveEffectiveEmbeddingModel('user-1')).toBe(ADA);
  });

  it('returns undefined when the credential is absent or expired (missing is non-null)', async () => {
    // The resolver deliberately refuses to substitute here, so no query vector can be produced at
    // all. Returning the configured model would be the one answer guaranteed to be wrong.
    getSettingsValue.mockResolvedValue(ADA);
    resolveEmbeddingWithKeylessFallback.mockReturnValue({ model: ADA, missing: 'openai', config: {} });

    expect(await resolveEffectiveEmbeddingModel('user-1')).toBeUndefined();
  });

  it('returns undefined for an unset or unregistered setting, without consulting the key table', async () => {
    getSettingsValue.mockResolvedValue('not-a-real-embedding-model');

    expect(await resolveEffectiveEmbeddingModel('user-1')).toBeUndefined();
    expect(getEffectiveLLMApiKeys).not.toHaveBeenCalled();
  });

  it('returns undefined rather than throwing when the settings read fails', async () => {
    getSettingsValue.mockRejectedValue(new Error('mongo down'));

    expect(await resolveEffectiveEmbeddingModel('user-1')).toBeUndefined();
  });

  it('returns undefined rather than throwing when the key-table lookup fails', async () => {
    // lakeMemoryRecall used to catch this one itself; it is caught here so both callers get it.
    getSettingsValue.mockResolvedValue(ADA);
    getEffectiveLLMApiKeys.mockRejectedValue(new Error('kms unavailable'));

    expect(await resolveEffectiveEmbeddingModel('user-1')).toBeUndefined();
  });

  it('uses an INJECTED key table instead of resolving its own', async () => {
    // /api/settings/serverConfig needs the same table for the tools picker and is hit on every page
    // load, so it resolves once and shares it.
    getSettingsValue.mockResolvedValue(ADA);
    resolveEmbeddingWithKeylessFallback.mockReturnValue({ model: ADA, missing: null, config: {} });

    await resolveEffectiveEmbeddingModel('user-1', { llmKeys: { voyageai: 'pa-live' } });

    expect(getEffectiveLLMApiKeys).not.toHaveBeenCalled();
    expect(resolveEmbeddingWithKeylessFallback).toHaveBeenCalledWith(ADA, { voyageai: 'pa-live' });
  });

  it('honours an injected NULL table as the answer rather than retrying the lookup', async () => {
    // null is the caller saying "my own lookup already failed". Re-running it here would just fail
    // again a moment later, and `resolveEmbeddingWithKeylessFallback` treats null like an empty
    // table anyway - which on a keyless stage is exactly the state that makes it substitute.
    getSettingsValue.mockResolvedValue(ADA);
    resolveEmbeddingWithKeylessFallback.mockReturnValue({ model: TITAN, missing: null, config: {} });

    expect(await resolveEffectiveEmbeddingModel('user-1', { llmKeys: null })).toBe(TITAN);

    expect(getEffectiveLLMApiKeys).not.toHaveBeenCalled();
    expect(resolveEmbeddingWithKeylessFallback).toHaveBeenCalledWith(ADA, null);
  });

  it('passes null for an anonymous caller instead of the string "undefined"', async () => {
    getSettingsValue.mockResolvedValue(ADA);
    resolveEmbeddingWithKeylessFallback.mockReturnValue({ model: ADA, missing: null, config: {} });

    await resolveEffectiveEmbeddingModel(undefined);

    expect(getEffectiveLLMApiKeys).toHaveBeenCalledWith(null, expect.anything());
  });
});

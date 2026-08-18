import { ModelBackend } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { buildApiKeyTable, isBackendUsable, resolveListingKey } from './backendGate';
import { getAvailableModels } from './index';

/**
 * `ApiKeyTable` is a Partial, so for years every caller hand-wrote its own literal
 * and each new provider was silently missing from whichever ones nobody
 * remembered. The Kimi launch missed five at once - including /api/models, which
 * meant no user could select a direct Kimi model at all while the two
 * Bedrock-served ids showed up regardless and made a smoke test look healthy.
 *
 * buildApiKeyTable is the single mapping those callers now share, and its internal
 * literal is a TOTAL Record<ModelBackend, ...> so the next provider is a compile
 * error rather than five silent omissions. These tests cover the runtime half of
 * that promise.
 */

const ALL_KEYS = {
  openai: 'sk-openai',
  anthropic: 'sk-anthropic',
  gemini: 'sk-gemini',
  bfl: 'sk-bfl',
  ollama: 'http://localhost:11434',
  xai: 'sk-xai',
  kimi: 'sk-moonshot',
  voyageai: 'sk-voyage',
  imageGen: 'http://localhost:7860',
};

/** Backends that hold no key of their own: AWS IAM covers both. */
const KEYLESS: ReadonlySet<string> = new Set<string>([ModelBackend.Bedrock, ModelBackend.AWS]);

describe('buildApiKeyTable', () => {
  it('maps a key for every backend that has one', () => {
    const table = buildApiKeyTable(ALL_KEYS);
    for (const backend of Object.values(ModelBackend)) {
      if (KEYLESS.has(backend)) continue;
      expect(table[backend], `${backend} resolved no credential from a full key set`).toBeTruthy();
    }
  });

  it('routes the Moonshot key to the Kimi backend', () => {
    expect(buildApiKeyTable(ALL_KEYS)[ModelBackend.Kimi]).toBe('sk-moonshot');
  });

  it('normalizes imageGen onto local-image, which has no key of that name', () => {
    // Leaving this un-normalized drops every local image model on the floor.
    expect(buildApiKeyTable(ALL_KEYS)[ModelBackend.LocalImage]).toBe('http://localhost:7860');
  });

  it('leaves the AWS-credentialed backends unset rather than inventing a key', () => {
    const table = buildApiKeyTable(ALL_KEYS);
    expect(table[ModelBackend.Bedrock]).toBeUndefined();
    expect(table[ModelBackend.AWS]).toBeUndefined();
  });

  it('turns a blank or null key into undefined, not an empty string', () => {
    // An empty string is falsy but still "present"; the gate reads truthiness, so
    // normalizing here keeps `resolveListingKey` from returning ''.
    const table = buildApiKeyTable({ kimi: '', xai: null });
    expect(table[ModelBackend.Kimi]).toBeUndefined();
    expect(table[ModelBackend.XAI]).toBeUndefined();
  });

  it('feeds the listing gate, so a mapped key makes its backend usable', () => {
    const ctx = { apiKeys: buildApiKeyTable(ALL_KEYS), isSelfHost: false };
    expect(resolveListingKey(ModelBackend.Kimi, ctx)).toBe('sk-moonshot');
    expect(isBackendUsable(ModelBackend.Kimi, ctx)).toBe(true);

    const without = { apiKeys: buildApiKeyTable({ ...ALL_KEYS, kimi: null }), isSelfHost: false };
    expect(isBackendUsable(ModelBackend.Kimi, without)).toBe(false);
  });
});

describe('getAvailableModels with a Moonshot key', () => {
  it('lists the direct Kimi models, which is what the picker route was missing', async () => {
    const models = await getAvailableModels(buildApiKeyTable({ kimi: 'sk-moonshot' }), { isSelfHost: true });
    const kimiIds = models.filter(m => m.backend === ModelBackend.Kimi).map(m => String(m.id));

    expect(kimiIds).toEqual(
      expect.arrayContaining(['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2.5'])
    );
  });

  it('lists none of them without the key', async () => {
    const models = await getAvailableModels(buildApiKeyTable({}), { isSelfHost: true });
    expect(models.some(m => m.backend === ModelBackend.Kimi)).toBe(false);
  });
});

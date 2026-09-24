import { ModelBackend } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { apiKeyTableForBackend, buildApiKeyTable, isBackendUsable, resolveListingKey } from './backendGate';
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
  deepseek: 'sk-deepseek',
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

  it('routes the DeepSeek key to the DeepSeek backend', () => {
    expect(buildApiKeyTable(ALL_KEYS)[ModelBackend.DeepSeek]).toBe('sk-deepseek');
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

  it('gates DeepSeek on its own key, which LISTING_KIND has to name', () => {
    // Marked anything but 'keyed' in LISTING_KIND, DeepSeek fails closed and silently: a valid key
    // and a working adapter still list nothing.
    const ctx = { apiKeys: buildApiKeyTable(ALL_KEYS), isSelfHost: false };
    expect(isBackendUsable(ModelBackend.DeepSeek, ctx)).toBe(true);

    const without = { apiKeys: buildApiKeyTable({ ...ALL_KEYS, deepseek: null }), isSelfHost: false };
    expect(isBackendUsable(ModelBackend.DeepSeek, without)).toBe(false);
  });
});

describe('apiKeyTableForBackend', () => {
  it('files the key under the stated backend, whatever the id would suggest', () => {
    // The ids that used to be sniffed onto the wrong key: an Ollama deepseek pull
    // resolved to the DeepSeek-direct key, so Ollama was never listed.
    expect(apiKeyTableForBackend(ModelBackend.Ollama, 'http://localhost:11434')).toEqual({
      [ModelBackend.Ollama]: 'http://localhost:11434',
    });
    for (const backend of Object.values(ModelBackend)) {
      if (KEYLESS.has(backend)) continue;
      expect(apiKeyTableForBackend(backend, 'k')).toEqual({ [backend]: 'k' });
    }
  });

  it('passes no key for the AWS-IAM backends', () => {
    // Bedrock-served deepseek.* and moonshot.* ids used to resolve to the
    // DeepSeek and Moonshot direct keys.
    expect(apiKeyTableForBackend(ModelBackend.Bedrock, 'k')).toEqual({});
    expect(apiKeyTableForBackend(ModelBackend.AWS, 'k')).toEqual({});
  });
});

describe('getAvailableModels with a Moonshot key', () => {
  it('lists the direct Kimi models, which is what the picker route was missing', async () => {
    const models = await getAvailableModels(buildApiKeyTable({ kimi: 'sk-moonshot' }), { isSelfHost: true });
    const kimiIds = models.filter(m => m.backend === ModelBackend.Kimi).map(m => String(m.id));

    expect(kimiIds).toEqual(
      expect.arrayContaining(['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'])
    );
    // kimi-k2.5 is absent on purpose: Moonshot discontinued the direct id and its
    // adapter row carries a past deprecationDate, which is what filters it here.
    expect(kimiIds).not.toContain('kimi-k2.5');
  });

  it('lists none of them without the key', async () => {
    const models = await getAvailableModels(buildApiKeyTable({}), { isSelfHost: true });
    expect(models.some(m => m.backend === ModelBackend.Kimi)).toBe(false);
  });
});

describe('getAvailableModels with a DeepSeek key', () => {
  it('lists the direct DeepSeek models', async () => {
    const models = await getAvailableModels(buildApiKeyTable({ deepseek: 'sk-deepseek' }), { isSelfHost: true });
    const ids = models.filter(m => m.backend === ModelBackend.DeepSeek).map(m => String(m.id));

    expect(ids).toEqual(expect.arrayContaining(['deepseek-flash', 'deepseek-v4-pro']));
  });

  it('lists none of them without the key', async () => {
    const models = await getAvailableModels(buildApiKeyTable({}), { isSelfHost: true });
    expect(models.some(m => m.backend === ModelBackend.DeepSeek)).toBe(false);
  });
});

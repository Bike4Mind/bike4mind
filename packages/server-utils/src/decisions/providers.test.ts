import type { Logger } from '@bike4mind/observability';
import { modelDiscoveryService } from '@bike4mind/services';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDecisionProviders, resolveCallableDecisionProviders, selectDecisionProviderKey } from './providers';

const { getEffectiveLLMApiKeys } = vi.hoisted(() => ({ getEffectiveLLMApiKeys: vi.fn() }));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return { ...actual, apiKeyService: { ...actual.apiKeyService, getEffectiveLLMApiKeys } };
});

type Keys = Parameters<typeof selectDecisionProviderKey>[1];

describe('buildDecisionProviders', () => {
  it('registers the systemOne adapter alongside OpenAI', () => {
    expect(buildDecisionProviders({}).map(provider => provider.id)).toEqual(['openaiDecisions', 'systemOne']);
  });

  it.each(['https://laya.example.com/', 'http://localhost:8080'])('accepts a valid SYSTEMONE_BASE_URL %s', value => {
    expect(() => buildDecisionProviders({ SYSTEMONE_BASE_URL: value })).not.toThrow();
  });

  it.each([
    'laya.example.com',
    'localhost:8080',
    'laya.example.com:8000',
    'ftp://laya.example.com',
    'https://laya.example.com/?a=b',
  ])('drops only the systemOne adapter, with an error log, when SYSTEMONE_BASE_URL is %s', value => {
    const logger = { error: vi.fn() } as unknown as Logger;
    const providers = buildDecisionProviders({ SYSTEMONE_BASE_URL: value }, logger);
    expect(providers.map(provider => provider.id)).toEqual(['openaiDecisions']);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('SYSTEMONE_BASE_URL'));
  });
});

describe('selectDecisionProviderKey', () => {
  const keys = { openai: 'sk-openai', typesafe: 'ts-key' } as unknown as Keys;

  it('maps each vendor to its own key', () => {
    expect(selectDecisionProviderKey('openai', keys)).toBe('sk-openai');
    expect(selectDecisionProviderKey('typesafe', keys)).toBe('ts-key');
    expect(selectDecisionProviderKey('test', keys)).toBe('test-key');
  });
});

describe('resolveCallableDecisionProviders', () => {
  const logger = {} as Logger;
  // Block body: a function returned from beforeEach runs as teardown, and mockReset() returns the mock.
  beforeEach(() => {
    getEffectiveLLMApiKeys.mockReset();
  });

  it('keeps only the providers the caller has a usable key for', async () => {
    getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-openai', typesafe: undefined });
    const callable = await resolveCallableDecisionProviders('user-1', ['openai', 'typesafe'], logger);
    expect([...callable]).toEqual(['openai']);
    expect(getEffectiveLLMApiKeys).toHaveBeenCalledTimes(1);
  });

  it('treats an expired key as missing, as a decision request would', async () => {
    getEffectiveLLMApiKeys.mockResolvedValue({
      openai: modelDiscoveryService.EXPIRED_KEY_SENTINEL,
      typesafe: 'ts-key',
    });
    const callable = await resolveCallableDecisionProviders('user-1', ['openai', 'typesafe'], logger);
    expect([...callable]).toEqual(['typesafe']);
  });

  it('always keeps the test provider and skips the key lookup when it is the only one', async () => {
    const callable = await resolveCallableDecisionProviders('user-1', ['test'], logger);
    expect([...callable]).toEqual(['test']);
    expect(getEffectiveLLMApiKeys).not.toHaveBeenCalled();
  });

  it('keeps the test provider and filters the rest with a single key lookup', async () => {
    getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-openai', typesafe: undefined });
    const callable = await resolveCallableDecisionProviders('user-1', ['test', 'openai', 'typesafe'], logger);
    expect([...callable].sort()).toEqual(['openai', 'test']);
    expect(getEffectiveLLMApiKeys).toHaveBeenCalledTimes(1);
  });

  it('treats a placeholder key as missing', async () => {
    getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'your-api-key', typesafe: 'ts-key' });
    const callable = await resolveCallableDecisionProviders('user-1', ['openai', 'typesafe'], logger);
    expect([...callable]).toEqual(['typesafe']);
  });

  it('returns an empty set without a key lookup for no providers', async () => {
    const callable = await resolveCallableDecisionProviders('user-1', [], logger);
    expect(callable.size).toBe(0);
    expect(getEffectiveLLMApiKeys).not.toHaveBeenCalled();
  });

  it('rejects when the key lookup fails, rather than failing open', async () => {
    getEffectiveLLMApiKeys.mockRejectedValue(new Error('db'));
    await expect(resolveCallableDecisionProviders('user-1', ['openai'], logger)).rejects.toThrow('db');
  });
});

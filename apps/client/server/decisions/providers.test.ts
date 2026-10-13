import type { Logger } from '@bike4mind/observability';
import { describe, expect, it, vi } from 'vitest';
import { buildDecisionProviders, selectDecisionProviderKey } from './providers';

type Keys = Parameters<typeof selectDecisionProviderKey>[1];

describe('buildDecisionProviders', () => {
  it('registers the systemOne adapter alongside OpenAI', () => {
    expect(buildDecisionProviders({}).map(provider => provider.id)).toEqual(['openaiDecisions', 'systemOne']);
  });

  it('accepts a valid SYSTEMONE_BASE_URL', () => {
    expect(() => buildDecisionProviders({ SYSTEMONE_BASE_URL: 'https://laya.example.com/' })).not.toThrow();
  });

  it('drops only the systemOne adapter, with an error log, when SYSTEMONE_BASE_URL is set but not a URL', () => {
    const logger = { error: vi.fn() } as unknown as Logger;
    const providers = buildDecisionProviders({ SYSTEMONE_BASE_URL: 'laya.example.com' }, logger);
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelBackend } from '@bike4mind/common';
import {
  isYoungAccount,
  LLM_USAGE_SETTLED_MESSAGE,
  llmSpendProvider,
  llmUsageSettledFields,
  logLlmUsageSettled,
} from './llmUsageSettledLog';

const now = new Date('2026-10-26T00:00:00.000Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('llmSpendProvider', () => {
  it('handles every current backend', () => {
    const named = new Map<string, string>([
      ['openai', 'openai'],
      ['anthropic', 'anthropic'],
      ['bedrock', 'bedrock'],
      ['gemini', 'google'],
    ]);
    for (const backend of Object.values(ModelBackend)) {
      expect(llmSpendProvider(backend)).toBe(named.get(backend) ?? 'other');
    }
  });
  it.each([
    ['anthropic', 'anthropic'],
    ['openai', 'openai'],
    ['bedrock', 'bedrock'],
    ['gemini', 'google'],
    ['xai', 'other'],
    ['deepseek', 'other'],
    ['bfl', 'other'],
    ['voyageai', 'other'],
    ['aws', 'other'],
    ['local-image', 'other'],
    ['kimi', 'other'],
    ['ollama', 'other'],
    ['', 'other'],
  ])('buckets %s as %s', (backend, provider) => {
    expect(llmSpendProvider(backend)).toBe(provider);
  });
});

describe('isYoungAccount', () => {
  it('uses the same 168-hour window as the young-account spend report', () => {
    expect(isYoungAccount(hoursAgo(1), now)).toBe(true);
    expect(isYoungAccount(hoursAgo(167.9), now)).toBe(true);
    expect(isYoungAccount(hoursAgo(168), now)).toBe(false);
    expect(isYoungAccount(hoursAgo(400), now)).toBe(false);
  });
  it('treats a missing or future creation date as not young', () => {
    expect(isYoungAccount(undefined, now)).toBe(false);
    expect(isYoungAccount(null, now)).toBe(false);
    expect(isYoungAccount(new Date(now.getTime() + 1000), now)).toBe(false);
  });
});

describe('llmUsageSettledFields', () => {
  it('rounds usd to 6 decimals and fills missing cache counts', () => {
    expect(
      llmUsageSettledFields(
        {
          backend: 'gemini',
          model: 'gemini-2.5-pro',
          inputTokens: 1000,
          outputTokens: 200,
          usd: 0.0123456789,
          source: 'api',
          accountCreatedAt: hoursAgo(2),
        },
        now
      )
    ).toEqual({
      provider: 'google',
      backend: 'gemini',
      model: 'gemini-2.5-pro',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usd: 0.012346,
      source: 'api',
      isYoungAccount: true,
    });
  });
  it('never emits a non-finite usd', () => {
    const fields = llmUsageSettledFields({
      backend: 'openai',
      model: 'gpt-4.1',
      inputTokens: 1,
      outputTokens: 1,
      usd: Number.NaN,
      source: 'cli',
    });
    expect(fields.usd).toBe(0);
  });
});

describe('logLlmUsageSettled', () => {
  it('writes one JSON line the metric filters can read, with no user or prompt fields', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    logLlmUsageSettled({
      backend: 'anthropic',
      model: 'claude-sonnet-4-5',
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 5000,
      cacheWriteTokens: 0,
      usd: 0.01234,
      source: 'chat',
      accountCreatedAt: new Date(Date.now() - 60_000),
    });
    expect(info).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(info.mock.calls[0][0]));
    expect(line).toMatchObject({
      message: LLM_USAGE_SETTLED_MESSAGE,
      severity: 'info',
      service: 'llmSpend',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 5000,
      usd: 0.01234,
      source: 'chat',
      isYoungAccount: true,
    });
    expect(typeof line.usd).toBe('number');
    expect(typeof line.outputTokens).toBe('number');
    expect(Object.keys(line).sort()).toEqual(
      [
        'backend',
        'cacheReadTokens',
        'cacheWriteTokens',
        'inputTokens',
        'isYoungAccount',
        'message',
        'model',
        'outputTokens',
        'provider',
        'service',
        'severity',
        'source',
        'usd',
      ].sort()
    );
  });
  it('does not suppress metric events when application logging is set to warn', () => {
    const originalLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'warn';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      logLlmUsageSettled({
        backend: 'openai',
        model: 'gpt-4.1',
        inputTokens: 1,
        outputTokens: 1,
        usd: 0.1,
        source: 'api',
      });
      expect(info).toHaveBeenCalledTimes(1);
    } finally {
      if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = originalLogLevel;
    }
  });
  it('swallows output failures', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() =>
      logLlmUsageSettled({
        backend: 'openai',
        model: 'gpt-4.1',
        inputTokens: 1,
        outputTokens: 1,
        usd: 0.1,
        source: 'api',
      })
    ).not.toThrow();
  });
});

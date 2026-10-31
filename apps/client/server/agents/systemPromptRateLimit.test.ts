import { describe, it, expect, vi } from 'vitest';
import { BadRequestError } from '@bike4mind/utils';
import {
  SystemPromptRateLimitError,
  assertSystemPromptGenerationAllowed,
  logSystemPromptGenerationFailure,
} from './systemPromptRateLimit';

const NOW = new Date('2026-08-10T03:45:06Z').getTime();

describe('assertSystemPromptGenerationAllowed', () => {
  it('allows the first generation on an agent that has never generated one', () => {
    expect(() => assertSystemPromptGenerationAllowed({}, 60, NOW)).not.toThrow();
  });

  it('allows generation for an agent whose prompt was seeded without a generation', () => {
    expect(() => assertSystemPromptGenerationAllowed({ lastSystemPromptGeneratedAt: null }, 60, NOW)).not.toThrow();
  });

  it('blocks a generation inside the cooldown window and reports the remainder', () => {
    const lastSystemPromptGeneratedAt = new Date(NOW - 30_000);

    expect(() => assertSystemPromptGenerationAllowed({ lastSystemPromptGeneratedAt }, 60, NOW)).toThrow(
      BadRequestError
    );
    expect(() => assertSystemPromptGenerationAllowed({ lastSystemPromptGeneratedAt }, 60, NOW)).toThrow(
      'Rate limit exceeded. Please wait 30 seconds before generating another system prompt.'
    );
  });

  it('allows generation once the cooldown window has elapsed', () => {
    expect(() =>
      assertSystemPromptGenerationAllowed({ lastSystemPromptGeneratedAt: new Date(NOW - 60_000) }, 60, NOW)
    ).not.toThrow();
  });

  it('accepts a serialized timestamp', () => {
    expect(() =>
      assertSystemPromptGenerationAllowed({ lastSystemPromptGeneratedAt: new Date(NOW - 1_000).toISOString() }, 60, NOW)
    ).toThrow(BadRequestError);
  });

  it('does not rate limit when the limit is disabled', () => {
    expect(() =>
      assertSystemPromptGenerationAllowed({ lastSystemPromptGeneratedAt: new Date(NOW) }, 0, NOW)
    ).not.toThrow();
  });
});

describe('logSystemPromptGenerationFailure', () => {
  const makeLogger = () => ({ warn: vi.fn(), error: vi.fn() });

  it('logs a rate-limit refusal at warn, not error', () => {
    const logger = makeLogger();
    logSystemPromptGenerationFailure(logger, 'failed:', new SystemPromptRateLimitError('Rate limit exceeded.'));
    expect(logger.warn).toHaveBeenCalledWith('failed:', 'Rate limit exceeded.');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('keeps any other BadRequestError at error', () => {
    const logger = makeLogger();
    const error = new BadRequestError('System prompt generation is currently disabled');
    logSystemPromptGenerationFailure(logger, 'failed:', error);
    expect(logger.error).toHaveBeenCalledWith('failed:', error);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps a provider failure at error', () => {
    const logger = makeLogger();
    const error = new Error('upstream 500');
    logSystemPromptGenerationFailure(logger, 'failed:', error);
    expect(logger.error).toHaveBeenCalledWith('failed:', error);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

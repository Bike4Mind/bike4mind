import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowError, WorkflowErrorCategory, categorizeError, withRetry } from '../workflowErrors';

// Mock Logger
const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as any;

describe('WorkflowError', () => {
  it('should create a WorkflowError with correct properties', () => {
    const error = new WorkflowError({
      message: 'System failure',
      category: WorkflowErrorCategory.INTERNAL_ERROR,
      userMessage: 'Something went wrong',
      context: { foo: 'bar' },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('System failure');
    expect(error.category).toBe(WorkflowErrorCategory.INTERNAL_ERROR);
    expect(error.userMessage).toBe('Something went wrong');
    expect(error.context).toEqual({ foo: 'bar' });
  });

  it('should format error for Slack correctly', () => {
    const error = new WorkflowError({
      message: 'Internal error',
      category: WorkflowErrorCategory.INTERNAL_ERROR,
      userMessage: 'User friendly message',
    });

    expect(error.toSlackError()).toEqual({
      error: {
        message: 'User friendly message',
      },
    });
  });

  it('should use message as userMessage if not provided', () => {
    const error = new WorkflowError({
      message: 'Simple error',
      category: WorkflowErrorCategory.USER_INPUT_INVALID,
    });

    expect(error.userMessage).toBe('Simple error');
  });
});

describe('categorizeError', () => {
  it('should return the error itself if it is already a WorkflowError', () => {
    const originalError = new WorkflowError({
      message: 'Test',
      category: WorkflowErrorCategory.RATE_LIMITED,
    });
    const result = categorizeError(originalError);
    expect(result).toBe(originalError);
  });

  it('should categorize slack platform errors as INTERNAL_ERROR', () => {
    const rawError = {
      code: 'slack_web_api_platform_error',
      message: 'Platform failed',
    };
    const result = categorizeError(rawError);
    expect(result.category).toBe(WorkflowErrorCategory.INTERNAL_ERROR);
    expect(result.userMessage).toBe('A Slack platform error occurred. Please try again.');
  });

  it('should categorize not_in_channel as PERMISSION_DENIED', () => {
    const rawError = {
      data: { error: 'not_in_channel' },
      message: 'Bot not in channel',
    };
    const result = categorizeError(rawError);
    expect(result.category).toBe(WorkflowErrorCategory.PERMISSION_DENIED);
    expect(result.userMessage).toBe('The bot does not have access to the specified channel.');
  });

  it('should categorize unknown errors as INTERNAL_ERROR', () => {
    const rawError = new Error('Random failure');
    const result = categorizeError(rawError);
    expect(result.category).toBe(WorkflowErrorCategory.INTERNAL_ERROR);
    expect(result.userMessage).toBe('An unexpected system error occurred.');
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return result immediately if operation succeeds', async () => {
    const operation = vi.fn().mockResolvedValue('success');
    const result = await withRetry(operation, {}, mockLogger);
    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should retry on transient errors', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ code: 'rate_limited' }) // Fail 1st time
      .mockResolvedValue('success'); // Succeed 2nd time

    const result = await withRetry(operation, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 }, mockLogger);

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Transient error, retrying'),
      expect.any(Object)
    );
  });

  it('should fail immediately on non-transient errors', async () => {
    const nonTransientError = new Error('Permanent failure');
    const operation = vi.fn().mockRejectedValue(nonTransientError);

    await expect(withRetry(operation, {}, mockLogger)).rejects.toThrow('Permanent failure');
    expect(operation).toHaveBeenCalledTimes(1); // No retry
  });

  it('should give up after max attempts', async () => {
    const transientError = { code: 'ETIMEDOUT' };
    const operation = vi.fn().mockRejectedValue(transientError);

    await expect(withRetry(operation, { maxAttempts: 3, baseDelayMs: 1 }, mockLogger)).rejects.toEqual(transientError);

    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should retry on WorkflowError with transient category', async () => {
    const transientWorkflowError = new WorkflowError({
      message: 'Rate limit',
      category: WorkflowErrorCategory.RATE_LIMITED,
    });

    const operation = vi.fn().mockRejectedValueOnce(transientWorkflowError).mockResolvedValue('success');

    const result = await withRetry(operation, { maxAttempts: 2, baseDelayMs: 1 }, mockLogger);

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

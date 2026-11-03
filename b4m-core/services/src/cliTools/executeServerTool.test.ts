import { describe, expect, it, vi } from 'vitest';
import { insufficientCreditsError } from '@bike4mind/common';
import { executeServerTool } from './executeServerTool';
import { ToolErrorType } from './types';

const adapters = { db: {} } as never;

const request = { toolName: 'decide' as const, input: { input: 'x', questions: [] }, userId: 'u1' };

describe('executeServerTool: decide', () => {
  it('dispatches to the host-injected executor with the parsed input', async () => {
    const decide = vi.fn(async () => '{"id":"dec_1","model":"gpt-6-luna","answers":[]}');

    const result = await executeServerTool(request, adapters, { decide });

    expect(decide).toHaveBeenCalledWith(request);
    expect(result).toMatchObject({ success: true, content: '{"id":"dec_1","model":"gpt-6-luna","answers":[]}' });
  });

  it('fails the tool rather than running it un-billed when no executor is wired', async () => {
    const result = await executeServerTool(request, adapters);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
    expect(result.errorType).toBe(ToolErrorType.UNKNOWN);
  });

  it('surfaces an executor failure as a failed tool result, not a throw', async () => {
    const decide = vi.fn(async () => {
      throw new Error('no such user');
    });

    const result = await executeServerTool(request, adapters, { decide });

    expect(result).toMatchObject({ success: false, error: 'no such user' });
  });
});

describe.each([
  ['web_search', { query: 'q' }],
  ['web_fetch', { url: 'https://example.com' }],
] as const)('executeServerTool: %s', (toolName, input) => {
  const webRequest = { toolName, input, userId: 'u1' };

  it('dispatches to the host-injected executor, which owns the billing', async () => {
    const executor = vi.fn(async () => 'result text');

    const result = await executeServerTool(webRequest, adapters, { [toolName]: executor });

    expect(executor).toHaveBeenCalledWith(webRequest);
    expect(result).toMatchObject({ success: true, content: 'result text' });
  });

  it('fails the tool rather than running it un-billed when no executor is wired', async () => {
    const result = await executeServerTool(webRequest, adapters);

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('not configured') });
  });

  it('carries the insufficient_credits classifier of a refused call', async () => {
    const executor = vi.fn(async () => {
      throw insufficientCreditsError('You do not have enough credits.');
    });

    const result = await executeServerTool(webRequest, adapters, { [toolName]: executor });

    expect(result).toMatchObject({
      success: false,
      error: 'You do not have enough credits.',
      errorCode: 'insufficient_credits',
    });
  });

  it('leaves errorCode unset for an unclassified failure', async () => {
    const executor = vi.fn(async () => {
      throw new Error('provider down');
    });

    const result = await executeServerTool(webRequest, adapters, { [toolName]: executor });

    expect(result.errorCode).toBeUndefined();
  });
});

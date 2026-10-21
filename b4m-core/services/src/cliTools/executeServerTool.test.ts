import { describe, expect, it, vi } from 'vitest';
import { executeServerTool } from './executeServerTool';
import { ToolErrorType } from './types';

const adapters = { db: {} } as never;

const request = { toolName: 'decide' as const, input: { input: 'x', questions: [] }, userId: 'u1' };

describe('executeServerTool: decide', () => {
  it('dispatches to the host-injected executor with the parsed input', async () => {
    const decide = vi.fn(async () => '{"id":"dec_1","model":"gpt-6-luna","answers":[]}');

    const result = await executeServerTool(request, adapters, undefined, { decide });

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

    const result = await executeServerTool(request, adapters, undefined, { decide });

    expect(result).toMatchObject({ success: false, error: 'no such user' });
  });
});

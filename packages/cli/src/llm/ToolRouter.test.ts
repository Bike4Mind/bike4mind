import { describe, it, expect } from 'vitest';
import { executeTool } from './ToolRouter';
import type { ApiClient } from '../auth/ApiClient';
import { MAX_TOOL_OUTPUT_CHARS } from '../utils/toolOutputSanitizer';

// Local tools never touch the ApiClient, so a bare stub is sufficient here.
const apiClient = {} as ApiClient;

// math_evaluate is a registered LOCAL tool - executeTool invokes the provided
// localToolFn, exercising the choke point without any network.
const LOCAL_TOOL = 'math_evaluate';

describe('executeTool choke point', () => {
  it('happy path: returns normal output unchanged', async () => {
    const result = await executeTool(LOCAL_TOOL, {}, apiClient, async () => 'the answer is 42');
    expect(result).toBe('the answer is 42');
  });

  it('thrown-error path: a token in a thrown error is redacted before it surfaces', async () => {
    const token = 'sk-ant-api03-' + 'a'.repeat(40);
    const promise = executeTool(LOCAL_TOOL, {}, apiClient, async () => {
      throw new Error(`upstream rejected key ${token}`);
    });
    await expect(promise).rejects.toThrow(/\[REDACTED\]/);
    await expect(promise).rejects.not.toThrow(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('oversize success path: output is truncated with a marker', async () => {
    const huge = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 1000);
    const result = await executeTool(LOCAL_TOOL, {}, apiClient, async () => huge);
    expect(result.length).toBeLessThan(huge.length);
    expect(result).toContain('[output truncated:');
  });

  it('oversize error path: a huge thrown error is truncated', async () => {
    const huge = 'y'.repeat(MAX_TOOL_OUTPUT_CHARS + 1000);
    const promise = executeTool(LOCAL_TOOL, {}, apiClient, async () => {
      throw new Error(huge);
    });
    await expect(promise).rejects.toThrow(/\[output truncated:/);
  });

  it('redacts a secret returned in a normal (non-error) tool result', async () => {
    const secret = 'ghp_' + 'b'.repeat(36);
    const result = await executeTool(LOCAL_TOOL, {}, apiClient, async () => `token is ${secret}`);
    expect(result).not.toContain(secret);
    expect(result).toContain('[REDACTED]');
  });
});

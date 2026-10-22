import { describe, expect, it, vi } from 'vitest';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import {
  PermissionDeniedError,
  getQuestErrorCode,
  insufficientCreditsError,
  spendCapExceededError,
} from '@bike4mind/common';
import { createToolFailureGuard, TOOL_FAILURE_BLOCK_AFTER } from './toolFailureGuard';
import { fileReadTool } from './implementation/fileRead';
import { knowledgeBaseRetrieveTool } from './implementation/knowledgeBaseRetrieve';
import { webFetchTool } from './implementation/webfetch';

function tool(name: string, toolFn: ICompletionOptionTools['toolFn']): ICompletionOptionTools {
  return {
    toolFn,
    toolSchema: { name, description: name, parameters: { type: 'object', properties: {} } },
  };
}

describe('createToolFailureGuard', () => {
  it('lets the first failure through unchanged', async () => {
    const [math] = createToolFailureGuard().apply([tool('math_evaluate', () => Promise.reject(new Error('bad')))]);
    await expect(math.toolFn({ expression: '1 +' })).rejects.toThrow(/^bad$/);
  });

  it('nudges from the second consecutive failure and blocks unrun after the limit', async () => {
    const impl = vi.fn(() => Promise.reject(new Error('parse error')));
    const [math] = createToolFailureGuard().apply([tool('math_evaluate', impl)]);

    await expect(math.toolFn({ expression: 'a' })).rejects.toThrow('parse error');
    await expect(math.toolFn({ expression: 'b' })).rejects.toThrow(/failed 2 times in a row/);
    for (let i = 3; i <= TOOL_FAILURE_BLOCK_AFTER; i++) {
      await expect(math.toolFn({ expression: `c${i}` })).rejects.toThrow('parse error');
    }
    expect(impl).toHaveBeenCalledTimes(TOOL_FAILURE_BLOCK_AFTER);

    await expect(math.toolFn({ expression: 'd' })).rejects.toThrow(/Not run: "math_evaluate" has failed 4 times/);
    expect(impl).toHaveBeenCalledTimes(TOOL_FAILURE_BLOCK_AFTER);
  });

  it('resets the count on a success, and counts each tool separately', async () => {
    let fail = true;
    const guard = createToolFailureGuard();
    const [flaky, broken] = guard.apply([
      tool('flaky', () => (fail ? Promise.reject(new Error('x')) : Promise.resolve('ok'))),
      tool('broken', () => Promise.reject(new Error('y'))),
    ]);

    for (let i = 0; i < TOOL_FAILURE_BLOCK_AFTER - 1; i++) await expect(flaky.toolFn()).rejects.toThrow();
    fail = false;
    await expect(flaky.toolFn()).resolves.toBe('ok');
    fail = true;
    await expect(flaky.toolFn()).rejects.toThrow(/^x$/);

    await expect(broken.toolFn()).rejects.toThrow(/^y$/);
  });

  it('reset() clears the counts for a restarted conversation', async () => {
    const guard = createToolFailureGuard();
    const [math] = guard.apply([tool('math_evaluate', () => Promise.reject(new Error('bad')))]);
    for (let i = 0; i < TOOL_FAILURE_BLOCK_AFTER; i++) await expect(math.toolFn()).rejects.toThrow();

    guard.reset();
    await expect(math.toolFn()).rejects.toThrow(/^bad$/);
  });

  it('passes successful results and the api key through', async () => {
    const impl = vi.fn(() => Promise.resolve('42'));
    const [math] = createToolFailureGuard().apply([tool('math_evaluate', impl)]);
    await expect(math.toolFn({ expression: '6*7' }, 'key')).resolves.toBe('42');
    expect(impl).toHaveBeenCalledWith({ expression: '6*7' }, 'key');
  });

  it('does not count or alter a permission denial', async () => {
    const denied = new PermissionDeniedError('delete_file');
    const message = denied.message;
    const [t] = createToolFailureGuard().apply([tool('delete_file', () => Promise.reject(denied))]);
    for (let i = 0; i <= TOOL_FAILURE_BLOCK_AFTER; i++) await expect(t.toolFn()).rejects.toBe(denied);
    expect(denied.message).toBe(message);
  });

  it.each([
    ['out-of-credits', () => insufficientCreditsError('no credits'), 'insufficient_credits'],
    ['spend-cap', () => spendCapExceededError('cap hit'), 'spend_cap_exceeded'],
  ])('passes a terminal %s error through unchanged and uncounted', async (_, makeError, code) => {
    const terminal = makeError();
    const impl = vi
      .fn<ICompletionOptionTools['toolFn']>()
      .mockRejectedValueOnce(new Error('provider error'))
      .mockRejectedValueOnce(terminal)
      .mockRejectedValueOnce(new Error('provider error'));
    const [image] = createToolFailureGuard().apply([tool('image_generation', impl)]);
    await expect(image.toolFn()).rejects.toThrow(/^provider error$/);
    const thrown = await image.toolFn().catch((e: unknown) => e);
    expect(thrown).toBe(terminal);
    expect(getQuestErrorCode(thrown)).toBe(code);
    await expect(image.toolFn()).rejects.toThrow(/failed 2 times in a row/);
  });

  it('counts a result starting with "Error:" as a failure and nudges it in the result', async () => {
    const impl = vi.fn(() => Promise.resolve('Error: missing "task" parameter'));
    const [delegate] = createToolFailureGuard().apply([tool('delegate_to_agent', impl)]);

    await expect(delegate.toolFn()).resolves.toBe('Error: missing "task" parameter');
    await expect(delegate.toolFn()).resolves.toMatch(/failed 2 times in a row/);
    for (let i = 3; i <= TOOL_FAILURE_BLOCK_AFTER; i++) await delegate.toolFn();
    await expect(delegate.toolFn()).rejects.toThrow(/Not run: "delegate_to_agent"/);
    expect(impl).toHaveBeenCalledTimes(TOOL_FAILURE_BLOCK_AFTER);
  });

  it('does not stack nudges on an error instance a tool rethrows every call', async () => {
    const shared = new Error('quota exceeded');
    const [t] = createToolFailureGuard().apply([tool('fmp', () => Promise.reject(shared))]);
    await expect(t.toolFn()).rejects.toThrow(/^quota exceeded$/);
    await expect(t.toolFn()).rejects.toThrow(/failed 2 times/);
    const third = await t.toolFn().catch((e: Error) => e);
    expect((third as Error).message.match(/times in a row/g)).toHaveLength(1);
    expect(shared.message).toBe('quota exceeded');
  });

  it('counts each failure of calls that run in parallel', async () => {
    const impl = vi.fn(() => Promise.reject(new Error('bad')));
    const [math] = createToolFailureGuard().apply([tool('math_evaluate', impl)]);
    await Promise.allSettled(Array.from({ length: TOOL_FAILURE_BLOCK_AFTER }, () => math.toolFn()));
    await expect(math.toolFn()).rejects.toThrow(/Not run/);
    expect(impl).toHaveBeenCalledTimes(TOOL_FAILURE_BLOCK_AFTER);
  });

  it('leaves input-dependent lookup tools unguarded', async () => {
    const impl = vi.fn(() => Promise.reject(new Error('404')));
    const [fetch] = createToolFailureGuard().apply([tool('web_fetch', impl)]);
    for (let i = 0; i <= TOOL_FAILURE_BLOCK_AFTER; i++) {
      await expect(fetch.toolFn({ url: `https://example.com/${i}` })).rejects.toThrow(/^404$/);
    }
    expect(impl).toHaveBeenCalledTimes(TOOL_FAILURE_BLOCK_AFTER + 1);
  });

  it('names the real lookup tools in its unguarded list', () => {
    for (const { name } of [webFetchTool, knowledgeBaseRetrieveTool, fileReadTool]) {
      const lookup = tool(name, () => Promise.resolve(''));
      expect(createToolFailureGuard().apply([lookup])[0]).toBe(lookup);
    }
  });
});

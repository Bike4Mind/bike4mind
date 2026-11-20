import { describe, it, expect, vi } from 'vitest';
import { ServerToolExecutor } from './ServerToolExecutor';
import type { ApiClient } from '../auth/ApiClient';

vi.mock('../utils/Logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const executorFor = (post: ReturnType<typeof vi.fn>) => new ServerToolExecutor({ post } as unknown as ApiClient);

// What the server answers (and axios throws) for a 422: the full tool response, success false.
const httpError = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

describe('ServerToolExecutor', () => {
  it('returns the content of a successful call', async () => {
    const post = vi.fn(async () => ({ success: true, content: 'results', executionTimeMs: 5 }));

    expect(await executorFor(post).executeTool('web_search', { query: 'q' })).toBe('results');
    expect(post).toHaveBeenCalledWith('/api/ai/v1/tools', { toolName: 'web_search', input: { query: 'q' } });
  });

  it.each(['web_search', 'web_fetch'])(
    'tells the model %s did not run, rather than crashing, when the account is out of credits',
    async tool => {
      const post = vi.fn(async () => {
        throw httpError(422, {
          success: false,
          error: 'You do not have enough credits for web search.',
          errorCode: 'insufficient_credits',
        });
      });

      const result = await executorFor(post).executeTool(tool, { query: 'q' });

      expect(result).toContain(`Error executing ${tool}: the account is out of credits, so the tool did not run.`);
      expect(result).toContain('add credits');
      expect(result).toContain('You do not have enough credits for web search.');
    }
  );

  it('keeps the plain error form for any other HTTP failure', async () => {
    const post = vi.fn(async () => {
      throw httpError(500, { success: false, error: 'provider down' });
    });

    expect(await executorFor(post).executeTool('web_search', { query: 'q' })).toBe(
      'Error executing web_search: provider down'
    );
  });

  it('does not read a 422 without the insufficient_credits code as an out-of-credits refusal', async () => {
    const post = vi.fn(async () => {
      throw httpError(422, { error: 'Validation failed' });
    });

    expect(await executorFor(post).executeTool('web_search', { query: 'q' })).toBe(
      'Error executing web_search: Validation failed'
    );
  });
});

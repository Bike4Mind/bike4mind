import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The poll endpoint renames the service's camelCase usage onto the wire shape
 * and persists it. Rename a key or drop one and nothing else in the repo
 * notices: the row stores results as Mixed, and the completed-batch
 * short-circuit returns them verbatim on every later poll, so a wrong key is
 * written once and served forever.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  updated: null as any,
  batch: {
    id: 'row1',
    ownerUserId: 'u1',
    status: 'in_progress',
    customIdMap: [{ customId: 'req_0', clientRef: 'art-1' }],
  } as any,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/utils/config', () => ({ Config: { ANTHROPIC_API_KEY: 'sk-test' } }));
vi.mock('@bike4mind/utils', () => ({
  NotFoundError: class extends Error {},
}));

vi.mock('@bike4mind/database', () => ({
  transformBatchRepository: {
    findByAnthropicBatchId: vi.fn(async () => mockRefs.batch),
    update: vi.fn(async (u: any) => {
      mockRefs.updated = u;
      return u;
    }),
  },
}));

vi.mock('@bike4mind/llm-adapters', () => ({
  AnthropicBatchService: {
    fromApiKey: () => ({
      getBatchResults: async () => ({
        processingStatus: 'ended',
        counts: { processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
        results: [
          {
            clientRef: 'art-1',
            status: 'done',
            reply: '{}',
            tokenUsage: {
              inputTokens: 5327,
              outputTokens: 2818,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 11394,
              cacheWrite5mInputTokens: 11394,
              cacheWrite1hInputTokens: 0,
            },
          },
        ],
      }),
    }),
  },
}));

import '@pages/api/transforms/batch/[id]';

async function poll() {
  const { req, res } = createMocks({ method: 'GET', query: { id: 'msgbatch_test' } });
  (req as any).user = { id: 'u1' };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  (req as any).requestId = 'req-1';
  await mockRefs.getHandler!(req, res);
  return JSON.parse(res._getData());
}

describe('GET /api/transforms/batch/:id -- token usage relay', () => {
  it('carries every cache counter onto the wire shape', async () => {
    const body = await poll();
    expect(body.results[0].tokenUsage).toEqual({
      actualInputTokens: 5327,
      actualOutputTokens: 2818,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 11394,
      cacheWrite5mInputTokens: 11394,
      cacheWrite1hInputTokens: 0,
    });
  });

  it('persists what it returns, since later polls are served from the row', async () => {
    const body = await poll();
    expect(mockRefs.updated.status).toBe('completed');
    expect(mockRefs.updated.results).toEqual(body.results);
  });
});

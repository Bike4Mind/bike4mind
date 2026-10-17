// @vitest-environment node
/**
 * Creating or retrying a research task enqueues platform-key LLM work, so a caller who cannot pay
 * is refused (422) before the task is created or re-queued.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { insufficientCreditsError } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  assertOwnerCanAfford: vi.fn(),
  create: vi.fn(),
  retry: vi.fn(),
  posts: [] as ((req: unknown, res: unknown) => unknown)[],
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    get: () => chain,
    delete: () => chain,
    post: (fn: (req: unknown, res: unknown) => unknown) => (m.posts.push(fn), chain),
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/billing/meterPlatformCompletion', () => ({ assertOwnerCanAfford: m.assertOwnerCanAfford }));
vi.mock('@server/utils/researchTasks', () => ({ researchTaskJobs: {} }));
vi.mock('@bike4mind/services', () => ({ researchTaskService: { create: m.create, retry: m.retry } }));
vi.mock('@bike4mind/database', () => ({
  researchTaskRepository: {},
  researchAgentRepository: {},
  taskScheduleRepository: {},
  withTransaction: vi.fn(),
}));

await import('../index');
await import('../[taskId]/retry');
const [createHandler, retryHandler] = m.posts;

const AGENT = 'a'.repeat(24);

async function call(handler: (req: unknown, res: unknown) => unknown, query: Record<string, string>, body = {}) {
  const { req, res } = createMocks({ method: 'POST', query, body });
  Object.assign(req, { user: { id: 'u1' } });
  await handler(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.assertOwnerCanAfford.mockResolvedValue(undefined);
  m.create.mockResolvedValue({ id: 't1' });
  m.retry.mockResolvedValue({ id: 't1' });
});

describe('research task create/retry metering', () => {
  it('refuses to create a task for a caller who cannot pay', async () => {
    m.assertOwnerCanAfford.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(
      call(createHandler, { id: AGENT }, { title: 'T', description: 'd', type: 'deepResearch', prompt: 'p' })
    ).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(m.create).not.toHaveBeenCalled();
  });

  it('refuses to retry a task for a caller who cannot pay', async () => {
    m.assertOwnerCanAfford.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(call(retryHandler, { id: AGENT, taskId: 't1' })).rejects.toMatchObject({ statusCode: 422 });
    expect(m.retry).not.toHaveBeenCalled();
  });

  it('retries a task for a funded caller', async () => {
    const res = await call(retryHandler, { id: AGENT, taskId: 't1' });
    expect(res._getJSONData()).toEqual({ id: 't1' });
  });
});

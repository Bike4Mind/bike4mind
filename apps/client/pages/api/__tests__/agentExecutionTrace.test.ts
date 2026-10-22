// @vitest-environment node
/**
 * Route test for the SPA-internal trace endpoint behind "Show reasoning". Sanitizing
 * `error` is `loadAgentExecutionTrace`'s job (mocked here); this pins that the route
 * passes it through so a replayed failed run can render its failure line.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockLoadTrace, mockChildren } = vi.hoisted(() => ({
  mockLoadTrace: vi.fn(),
  mockChildren: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ get: (handler: unknown) => handler }),
}));
vi.mock('@server/utils/loadAgentExecutionTrace', () => ({ loadAgentExecutionTrace: mockLoadTrace }));
vi.mock('@server/utils/childExecutionSnapshot', () => ({ buildChildExecutionSnapshots: mockChildren }));

const { default: handler } = await import('@pages/api/agent-executions/[id]/index');

function get(id: string) {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  Object.assign(req, { user: { id: 'u1' } });
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockChildren.mockResolvedValue([]);
});

describe('GET /api/agent-executions/[id]', () => {
  it('returns the caller-safe error of a failed run', async () => {
    mockLoadTrace.mockResolvedValue({
      status: 'failed',
      answer: null,
      error: 'Execution stopped: you denied "video_generation".',
      steps: [],
      totalIterations: 1,
    });
    const { req, res } = get('exec1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handler as any)(req, res);

    expect(mockLoadTrace).toHaveBeenCalledWith('exec1', 'u1');
    expect(res._getJSONData()).toEqual({
      id: 'exec1',
      status: 'failed',
      answer: null,
      error: 'Execution stopped: you denied "video_generation".',
      steps: [],
      totalIterations: 1,
      children: [],
    });
  });

  it('returns a null error for a completed run', async () => {
    mockLoadTrace.mockResolvedValue({
      status: 'completed',
      answer: 'done',
      error: null,
      steps: [],
      totalIterations: 1,
    });
    const { req, res } = get('exec1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handler as any)(req, res);

    expect(res._getJSONData().error).toBeNull();
  });
});

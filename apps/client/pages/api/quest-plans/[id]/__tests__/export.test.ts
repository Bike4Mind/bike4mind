import { beforeEach, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
const h = vi.hoisted(() => ({
  post: undefined as undefined | ((req: unknown, res: unknown) => Promise<void>),
  findById: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use: () => chain,
      post: (...fns: unknown[]) => {
        h.post = fns.at(-1) as typeof h.post;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: vi.fn() }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ questMasterPlanRepository: { findById: h.findById } }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.send }));
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl: () => 'http://queue/questExport' }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), error: vi.fn() } }));
import '../export';
const invoke = async () => {
  const { req, res } = createMocks({ method: 'POST', query: { id: '507f1f77bcf86cd799439011' } });
  Object.assign(req, { user: { id: 'owner' } });
  await h.post!(req, res);
  return res;
};
beforeEach(() => {
  vi.clearAllMocks();
  h.findById.mockResolvedValue({ userId: 'owner' });
  h.send.mockResolvedValue('accepted');
});
it('returns failure when the broker rejects initial acceptance', async () => {
  h.send.mockRejectedValueOnce(new Error('broker unavailable'));
  const res = await invoke();
  expect(res.statusCode).toBe(500);
  expect(res._getJSONData()).toEqual({ error: 'Failed to start export. Please try again.' });
});
it('waits for enqueue acceptance before returning the job identity', async () => {
  let accept!: () => void;
  h.send.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        accept = resolve;
      })
  );
  let settled = false;
  const pending = invoke().then(res => {
    settled = true;
    return res;
  });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  accept();
  const res = await pending;
  expect(res.statusCode).toBe(202);
  expect(h.send).toHaveBeenCalledWith(
    'http://queue/questExport',
    expect.objectContaining({ exportJobId: res._getJSONData().exportJobId, userId: 'owner' })
  );
});
it('preserves plan authorization before submitting work', async () => {
  h.findById.mockResolvedValueOnce({ userId: 'someone-else' });
  expect((await invoke()).statusCode).toBe(403);
  expect(h.send).not.toHaveBeenCalled();
});

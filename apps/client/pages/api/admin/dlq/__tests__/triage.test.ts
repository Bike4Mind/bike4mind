// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  post: undefined as ((req: unknown, res: unknown) => Promise<unknown>) | undefined,
  options: undefined as unknown,
  visible: vi.fn(),
  transition: vi.fn(),
  audit: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    h.options = options;
    const route = {
      get: () => route,
      post: (fn: typeof h.post) => {
        h.post = fn;
        return route;
      },
    };
    return route;
  },
}));
vi.mock('@bike4mind/server-utils/admin/dlq/triage', () => ({ visibleDlqSuggestion: h.visible }));
vi.mock('@bike4mind/database', () => ({
  adminAiSuggestionRepository: { transition: h.transition },
  withTransaction: h.transaction,
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));
import '../triage';

const invoke = () => {
  const { req, res } = createMocks({
    method: 'POST',
    body: {
      queue: 'fixture',
      message: 'm1',
      suggestionId: 'a'.repeat(24),
      decision: 'dismiss',
    },
  });
  Object.assign(req, { user: { id: 'admin-1', name: 'Admin' } });
  return h.post!(req, res);
};
beforeEach(() => {
  vi.resetAllMocks();
  h.visible.mockResolvedValue({ id: 'a'.repeat(24) });
  h.transition.mockResolvedValue({ status: 'dismissed' });
  h.transaction.mockImplementation((fn: () => Promise<unknown>) => fn());
});
describe('DLQ triage dismiss', () => {
  it('requires authenticated decision permission and records the approving admin transactionally', async () => {
    await invoke();
    expect(h.options).toMatchObject({ auth: 'jwtOnly', adminPermissions: { POST: 'settings:manage' } });
    expect(h.transaction).toHaveBeenCalledOnce();
    expect(h.transition).toHaveBeenCalledWith('a'.repeat(24), ['pending'], 'dismissed', {
      decidedBy: { userId: 'admin-1', name: 'Admin' },
    });
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.dlq.triage.dismissed',
      details: { messageId: 'm1' },
    });
  });
  it('propagates an audit failure through the transaction so the decision rolls back', async () => {
    h.audit.mockRejectedValue(new Error('audit unavailable'));
    await expect(invoke()).rejects.toThrow('audit unavailable');
    expect(h.transaction).toHaveBeenCalledOnce();
  });
  it('rejects a stale decision without an audit write', async () => {
    h.transition.mockResolvedValue(null);
    await expect(invoke()).rejects.toThrow('already been decided');
    expect(h.audit).not.toHaveBeenCalled();
  });
});

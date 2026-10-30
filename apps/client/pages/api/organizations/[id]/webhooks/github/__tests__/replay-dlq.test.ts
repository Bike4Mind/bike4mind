// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from '@bike4mind/utils';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  verifyOrgOwner: vi.fn(),
  incrementCounterConditional: vi.fn(),
  findConfig: vi.fn(),
  findDeliveries: vi.fn(),
  sqsSend: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return {};
    },
  }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/database/infra', () => ({
  orgWebhookConfigRepository: { findByOrganizationId: h.findConfig },
  webhookDeliveryRepository: { find: h.findDeliveries },
}));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { incrementCounterConditional: h.incrementCounterConditional },
}));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = h.sqsSend;
  },
  SendMessageCommand: class {},
}));
vi.mock('sst', () => ({ Resource: {} }));
// Only `verifyOrgOwner` is exported, so a route reverted to another org gate would fail loudly here.
vi.mock('@bike4mind/server-utils/utils/orgAccess', () => ({ verifyOrgOwner: h.verifyOrgOwner }));

await import('../replay-dlq');

describe('POST /api/organizations/[id]/webhooks/github/replay-dlq', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.incrementCounterConditional.mockResolvedValue({ success: true });
  });

  it('refuses a non-owner before reading deliveries or sending to the queue', async () => {
    h.verifyOrgOwner.mockRejectedValue(new NotFoundError('Organization not found'));
    const req = {
      query: { id: 'org-1' },
      user: { id: 'manager-1' },
      body: { all: true },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    };
    const res = { status: vi.fn(() => res), json: vi.fn(() => res) };

    await expect(h.handler!(req, res)).rejects.toThrow(NotFoundError);

    expect(h.verifyOrgOwner).toHaveBeenCalledWith(req.user, 'org-1');
    expect(h.findConfig).not.toHaveBeenCalled();
    expect(h.findDeliveries).not.toHaveBeenCalled();
    expect(h.sqsSend).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

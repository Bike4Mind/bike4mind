// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handler: undefined as undefined | Handler,
  receiveFromQueue: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => ({
    get: (fn: Handler) => {
      h.handler = fn;
      return fn;
    },
  }),
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getDlqByLabel: (label: string) => ({ label }),
  getDlqUrl: () => 'https://sqs.example/dlq',
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ receiveFromQueue: h.receiveFromQueue }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn() } }));

import '../messages';

const message = { MessageId: 'm1', Body: '{}', ReceiptHandle: 'handle-1', Attributes: {} };

const peek = async (adminPermissions: string[]) => {
  const res = { json: vi.fn() };
  await h.handler!({ query: { queue: 'q1' }, user: { id: 'u1', isAdmin: false, adminPermissions } }, res);
  return res.json.mock.calls[0][0] as { messages: Array<{ receiptHandle?: string }> };
};

describe('GET /api/admin/dlq/messages', () => {
  beforeEach(() => {
    h.receiveFromQueue.mockReset().mockResolvedValue([message]);
  });

  it('holds messages and returns receipt handles for a settings:manage caller', async () => {
    const body = await peek(['settings:manage']);

    expect(h.receiveFromQueue).toHaveBeenCalledWith('https://sqs.example/dlq', 10, 120);
    expect(body.messages[0].receiptHandle).toBe('handle-1');
  });

  it('leaves messages visible and omits receipt handles for a support:read caller', async () => {
    const body = await peek(['support:read']);

    expect(h.receiveFromQueue).toHaveBeenCalledWith('https://sqs.example/dlq', 10, 0);
    expect(body.messages[0].receiptHandle).toBeUndefined();
  });
});

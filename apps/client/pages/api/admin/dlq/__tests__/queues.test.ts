// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const h = vi.hoisted(() => ({ handler: undefined as Handler | undefined, getQueueAttributes: vi.fn() }));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => ({
    get: (handler: Handler) => {
      h.handler = handler;
      return handler;
    },
  }),
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getDlqRegistry: () => [
    {
      label: 'events',
      displayName: 'Events',
      application: 'Example',
      sourceQueue: null,
      replay: 'unsafe',
    },
  ],
  getDlqUrl: () => 'dlq-url',
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ getQueueAttributes: h.getQueueAttributes }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), warn: vi.fn() } }));

import '../queues';

describe('GET /api/admin/dlq/queues', () => {
  beforeEach(() => {
    h.getQueueAttributes.mockReset().mockResolvedValue({ approximateMessageCount: 2, approximateNotVisibleCount: 0 });
  });

  it.each([false, true])('lists unsafe queues and their safety even when attributes fail: %s', async fail => {
    if (fail) h.getQueueAttributes.mockRejectedValue(new Error('Unavailable'));
    const res = { json: vi.fn() };
    await h.handler!({ user: { id: 'admin' } }, res);
    expect(res.json).toHaveBeenCalledWith({
      queues: [
        {
          label: 'events',
          displayName: 'Events',
          application: 'Example',
          replay: 'unsafe',
          approximateMessageCount: fail ? -1 : 2,
          approximateNotVisibleCount: fail ? -1 : 0,
        },
      ],
    });
    expect(h.getQueueAttributes).toHaveBeenCalledWith('dlq-url');
  });
});

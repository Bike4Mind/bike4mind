// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

type AdminPermissions = Record<string, string>;

const h = vi.hoisted(() => {
  const captured: AdminPermissions[] = [];
  return { captured };
});

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: { adminPermissions: AdminPermissions }) => {
    h.captured.push(options.adminPermissions);
    const noop = () => undefined;
    const chain = Object.assign(noop, {
      get: () => chain,
      post: () => chain,
      use: () => chain,
    });
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getDlqByLabel: () => undefined,
  getDlqUrl: () => '',
  getDlqRegistry: () => [],
  getSourceQueueUrl: () => '',
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  receiveFromQueue: vi.fn(),
  sendToQueue: vi.fn(),
  deleteFromQueue: vi.fn(),
  getQueueAttributes: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  dlqReplayLogRepository: { countAttempts: vi.fn(), logReplay: vi.fn(), findRecent: vi.fn() },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: Object.assign(vi.fn(), { info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn() }));

// Each import triggers adminApi() at module level, pushing to `captured` in import order.
import '../messages';
import '../queues';
import '../history';
import '../replay';
import '../discard';

const [messagesPerms, queuesPerms, historyPerms, replayPerms, discardPerms] = h.captured;

describe('DLQ route permission declarations', () => {
  it('messages GET requires support:read (view), not settings:manage', () => {
    expect(messagesPerms).toMatchObject({ GET: 'support:read' });
    expect(messagesPerms.GET).not.toBe('settings:manage');
  });

  it('queues GET requires support:read', () => {
    expect(queuesPerms).toMatchObject({ GET: 'support:read' });
  });

  it('history GET requires support:read', () => {
    expect(historyPerms).toMatchObject({ GET: 'support:read' });
  });

  it('replay POST requires settings:manage (action)', () => {
    expect(replayPerms).toMatchObject({ POST: 'settings:manage' });
  });

  it('discard POST requires settings:manage (action)', () => {
    expect(discardPerms).toMatchObject({ POST: 'settings:manage' });
  });

  it('no view route requires settings:manage', () => {
    for (const perms of [messagesPerms, queuesPerms, historyPerms]) {
      expect(Object.values(perms)).not.toContain('settings:manage');
    }
  });
});

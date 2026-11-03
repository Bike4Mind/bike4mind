import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/utils/eventBus', () => ({ NotificationEvents: { Push: { publish: vi.fn() } } }));
const pushDelivery = vi.hoisted(() => ({ configured: true }));
vi.mock('@bike4mind/server-utils/utils/pushDelivery', () => ({
  isPushDeliveryConfigured: () => pushDelivery.configured,
}));

import { publishChatCompletedPush } from './questProcessor.push';

const logger = { warn: vi.fn() };
const turn = { userId: 'user-1', sessionId: 'session-1', questId: 'quest-1', sessionName: 'Q3 plan' };

function makeDeps({
  connections = [] as unknown[] | Error,
  quest = { status: 'done', type: 'chat', reply: 'Here is   the\nsummary.' } as unknown,
} = {}) {
  return {
    connections: {
      findByUserId: vi.fn(async () => {
        if (connections instanceof Error) throw connections;
        return connections;
      }),
    },
    findQuest: vi.fn(async () => quest as never),
    sessionDeepLink: (id: string) => `/notebooks/${id}`,
    publish: vi.fn(async () => undefined),
  };
}

describe('publishChatCompletedPush connection gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushDelivery.configured = true;
  });

  it('reads nothing and publishes nothing while push delivery is unconfigured', async () => {
    pushDelivery.configured = false;
    const deps = makeDeps();
    await publishChatCompletedPush(turn, deps, logger);
    expect(deps.connections.findByUserId).not.toHaveBeenCalled();
    expect(deps.findQuest).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('pushes the finished reply to a user with no live connection', async () => {
    const deps = makeDeps();
    await publishChatCompletedPush(turn, deps, logger);
    expect(deps.connections.findByUserId).toHaveBeenCalledWith('user-1');
    expect(deps.publish).toHaveBeenCalledExactlyOnceWith({
      userId: 'user-1',
      category: 'chat_completed',
      title: 'Q3 plan',
      body: 'Here is the summary.',
      deepLink: '/notebooks/session-1',
      collapseId: 'chat:quest-1',
      questId: 'quest-1',
      sessionId: 'session-1',
    });
  });

  it('does not push a user whose client is connected and already streamed the reply', async () => {
    const deps = makeDeps({ connections: [{ connectionId: 'c1' }] });
    await publishChatCompletedPush(turn, deps, logger);
    expect(deps.findQuest).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('treats an unreadable connection table as offline and still pushes', async () => {
    const deps = makeDeps({ connections: new Error('db down') });
    await publishChatCompletedPush(turn, deps, logger);
    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection lookup failed'), expect.any(Object));
  });

  it('skips API-key turns without reading connections', async () => {
    const deps = makeDeps();
    await publishChatCompletedPush({ ...turn, apiKeyId: 'key-1' }, deps, logger);
    expect(deps.connections.findByUserId).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['still running', { status: 'running' }],
    ['errored', { status: 'done', type: 'error' }],
    ['missing', null],
  ])('skips a quest that is %s', async (_label, quest) => {
    const deps = makeDeps({ quest });
    await publishChatCompletedPush(turn, deps, logger);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('falls back to generic copy without a session name or reply', async () => {
    const deps = makeDeps({ quest: { status: 'done', reply: '' } });
    await publishChatCompletedPush({ ...turn, sessionName: undefined }, deps, logger);
    expect(deps.publish).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Reply ready', body: 'Your reply is ready.' })
    );
  });
});

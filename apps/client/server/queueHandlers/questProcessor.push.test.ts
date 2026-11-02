import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/utils/eventBus', () => ({
  NotificationEvents: { Push: { publish: vi.fn() }, LiveActivity: { publish: vi.fn() } },
}));
const pushDelivery = vi.hoisted(() => ({ configured: true }));
vi.mock('@bike4mind/server-utils/utils/pushDelivery', () => ({
  isPushDeliveryConfigured: () => pushDelivery.configured,
}));

import type { WatchedConnectionRow } from '@server/utils/pushNotifications';
import { createChatLiveActivity, publishChatCompletedPush } from './questProcessor.push';

const logger = { warn: vi.fn() };
const liveWebRow = { source: 'web', authExpiresAt: new Date(Date.now() + 10 * 60_000) };
const turn = { userId: 'user-1', sessionId: 'session-1', questId: 'quest-1', sessionName: 'Q3 plan' };

function makeDeps({
  connections = [] as WatchedConnectionRow[] | Error,
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
    const deps = makeDeps({ connections: [liveWebRow] });
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

  it('sends approval_needed instead of chat_completed for a turn parked on a Confirm card', async () => {
    const deps = makeDeps({
      quest: { status: 'done', type: 'chat', reply: 'Preview ready.', pendingAction: { tool: 'github_create_issue' } },
    });
    await publishChatCompletedPush(turn, deps, logger);
    expect(deps.publish).toHaveBeenCalledExactlyOnceWith({
      userId: 'user-1',
      category: 'approval_needed',
      title: 'Approval needed',
      body: 'An agent wants to run github_create_issue and is waiting for your confirmation.',
      deepLink: '/notebooks/session-1',
      collapseId: 'approval:quest-1',
      questId: 'quest-1',
      sessionId: 'session-1',
    });
  });

  it('falls back to generic copy without a session name or reply', async () => {
    const deps = makeDeps({ quest: { status: 'done', reply: '' } });
    await publishChatCompletedPush({ ...turn, sessionName: undefined }, deps, logger);
    expect(deps.publish).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Reply ready', body: 'Your reply is ready.' })
    );
  });
});

describe('createChatLiveActivity', () => {
  const liveTurn = { userId: 'user-1', questId: 'quest-1' };

  function makeLive(
    quest: { status?: string; type?: string } | null | Error = { status: 'done', type: 'chat' },
    turnOverride = liveTurn
  ) {
    const publishLiveActivity = vi.fn(async () => undefined);
    const findQuest = vi.fn(async () => {
      if (quest instanceof Error) throw quest;
      return quest;
    });
    const live = createChatLiveActivity(turnOverride, { findQuest, publishLiveActivity }, logger);
    return { live, publishLiveActivity, findQuest };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    pushDelivery.configured = true;
  });

  it('mirrors a status line as a running update for its own quest only', () => {
    const { live, publishLiveActivity } = makeLive();
    expect(live.onStatusUpdate).toBeTypeOf('function');
    live.onStatusUpdate?.('other-quest', 'Not mine');
    live.onStatusUpdate?.('quest-1', 'Searching the web');

    expect(publishLiveActivity).toHaveBeenCalledExactlyOnceWith({
      userId: 'user-1',
      questId: 'quest-1',
      event: 'update',
      contentState: { status: 'running', stageLabel: 'Searching the web' },
    });
  });

  it.each([
    ['done', { status: 'done', type: 'chat' }, { status: 'completed' }],
    ['an error quest', { status: 'done', type: 'error' }, { status: 'failed', errored: true }],
    ['a stopped quest', { status: 'stopped', type: 'chat' }, { status: 'stopped' }],
    ['a missing quest', null, { status: 'completed' }],
  ])('ends with the outcome of %s', async (_label, quest, contentState) => {
    const { live, publishLiveActivity } = makeLive(quest);
    await live.end();
    expect(publishLiveActivity).toHaveBeenCalledExactlyOnceWith({
      userId: 'user-1',
      questId: 'quest-1',
      event: 'end',
      contentState,
    });
  });

  it('ends as failed without reading the quest when told the turn failed', async () => {
    const { live, publishLiveActivity, findQuest } = makeLive();
    await live.end('failed');
    expect(findQuest).not.toHaveBeenCalled();
    expect(publishLiveActivity.mock.calls[0][0].contentState).toEqual({ status: 'failed', errored: true });
  });

  it('does not gate on a live websocket connection and does not throw when the quest read fails', async () => {
    const { live, publishLiveActivity } = makeLive(new Error('db down'));
    await expect(live.end()).resolves.toBeUndefined();
    expect(publishLiveActivity).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('[LiveActivity] chat live activity end failed', expect.anything());
  });

  it('is inert for API-key turns', async () => {
    const { live, publishLiveActivity } = makeLive(undefined, { ...liveTurn, apiKeyId: 'key-1' } as typeof liveTurn);
    expect(live.onStatusUpdate).toBeUndefined();
    await live.end();
    expect(publishLiveActivity).not.toHaveBeenCalled();
  });

  it('installs no status observer and ends without a read or publish while push is unconfigured', async () => {
    pushDelivery.configured = false;
    const { live, publishLiveActivity, findQuest } = makeLive();
    expect(live.onStatusUpdate).toBeUndefined();
    await live.end();
    await live.end('failed');
    expect(findQuest).not.toHaveBeenCalled();
    expect(publishLiveActivity).not.toHaveBeenCalled();
  });
});

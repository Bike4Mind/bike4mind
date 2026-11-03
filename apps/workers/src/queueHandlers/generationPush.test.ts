import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/utils/eventBus', () => ({ NotificationEvents: { Push: { publish: vi.fn() } } }));
const pushDelivery = vi.hoisted(() => ({ configured: true }));
vi.mock('@bike4mind/server-utils/utils/pushDelivery', () => ({
  isPushDeliveryConfigured: () => pushDelivery.configured,
}));

import { publishGenerationJobReadyPush, publishImageQuestReadyPush } from './generationPush';

const logger = { warn: vi.fn() };

const videoJob = {
  id: 'job-1',
  kind: 'video',
  state: 'succeeded',
  requestedBy: 'user-1',
  questId: 'quest-1',
  payload: { request: { prompt: 'A  fox\nrunning through snow' } },
};

function jobDeps(job: unknown) {
  return {
    findJob: vi.fn(async () => job as never),
    sessionDeepLink: (id: string) => `/notebooks/${id}`,
    appRootDeepLink: () => '/',
    publish: vi.fn(async () => undefined),
  };
}

describe('publishGenerationJobReadyPush', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushDelivery.configured = true;
  });

  it('reads nothing and publishes nothing while push delivery is unconfigured', async () => {
    pushDelivery.configured = false;
    const deps = jobDeps(videoJob);
    await publishGenerationJobReadyPush('job-1', deps, logger);
    expect(deps.findJob).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('publishes generation_ready for a succeeded video job, collapsed per job', async () => {
    const deps = jobDeps(videoJob);
    await publishGenerationJobReadyPush('job-1', deps, logger);
    expect(deps.publish).toHaveBeenCalledExactlyOnceWith({
      userId: 'user-1',
      category: 'generation_ready',
      title: 'Video ready',
      body: 'A fox running through snow',
      deepLink: '/',
      collapseId: 'generation:job-1',
      questId: 'quest-1',
    });
  });

  it('links a music job to its notebook', async () => {
    const deps = jobDeps({ ...videoJob, kind: 'music', payload: { sessionId: 's1', request: {} } });
    await publishGenerationJobReadyPush('job-1', deps, logger);
    expect(deps.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Song ready',
        body: 'Your music is ready.',
        deepLink: '/notebooks/s1',
        sessionId: 's1',
      })
    );
  });

  it.each([
    ['failed job', { ...videoJob, state: 'failed' }],
    ['Slack-delivered job', { ...videoJob, delivery: { channel: 'slack' } }],
    ['missing job', null],
  ])('does not push a %s', async (_label, job) => {
    const deps = jobDeps(job);
    await publishGenerationJobReadyPush('job-1', deps, logger);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const deps = jobDeps(videoJob);
    deps.findJob.mockRejectedValue(new Error('db down'));
    await expect(publishGenerationJobReadyPush('job-1', deps, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('publishImageQuestReadyPush', () => {
  beforeEach(() => vi.clearAllMocks());

  const body = { questId: 'quest-1', userId: 'user-1', sessionId: 'session-1' };

  function imageDeps({ connected = false, quest = { status: 'done', images: ['a.png'] } as unknown } = {}) {
    return {
      connections: { findByUserId: vi.fn(async () => (connected ? [{ id: 'c1' }] : [])) },
      findQuest: vi.fn(async () => quest as never),
      sessionDeepLink: (id: string) => `/notebooks/${id}`,
      publish: vi.fn(async () => undefined),
    };
  }

  it('pushes an offline user when the image quest settled with images', async () => {
    const deps = imageDeps({ quest: { status: 'done', images: ['a', 'b'] } });
    await publishImageQuestReadyPush(body, 'edit', deps, logger);
    expect(deps.publish).toHaveBeenCalledExactlyOnceWith({
      userId: 'user-1',
      category: 'generation_ready',
      title: 'Image edit ready',
      body: '2 images are ready.',
      deepLink: '/notebooks/session-1',
      collapseId: 'generation:quest-1',
      questId: 'quest-1',
      sessionId: 'session-1',
    });
  });

  it('skips a user with a live connection', async () => {
    const deps = imageDeps({ connected: true });
    await publishImageQuestReadyPush(body, 'generate', deps, logger);
    expect(deps.findQuest).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['an errored quest', { status: 'error', images: [] }],
    ['a quest without images', { status: 'done', images: [] }],
  ])('skips %s', async (_label, quest) => {
    const deps = imageDeps({ quest });
    await publishImageQuestReadyPush(body, 'generate', deps, logger);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('ignores a malformed body', async () => {
    const deps = imageDeps();
    await publishImageQuestReadyPush({ questId: 'q' }, 'generate', deps, logger);
    expect(deps.connections.findByUserId).not.toHaveBeenCalled();
  });
});

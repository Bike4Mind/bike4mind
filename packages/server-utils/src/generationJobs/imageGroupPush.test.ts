import { beforeEach, describe, expect, it, vi } from 'vitest';
import { studioCompletionLink, type PushNotificationEvent } from '@bike4mind/common';
import type { GroupCompletion } from '@bike4mind/services/generationJobs';

const pushDelivery = vi.hoisted(() => ({ configured: true }));
vi.mock('../utils/pushDelivery', () => ({ isPushDeliveryConfigured: () => pushDelivery.configured }));
vi.mock('../utils/eventBus', () => ({ NotificationEvents: { Push: { publish: vi.fn() } } }));

import { imageGroupPushSubscriber, type ImageGroupPushDeps } from './imageGroupPush';

const GROUP_ID = '6734a0000000000000000000';
const FUTURE = new Date(Date.now() + 60_000);

type JobOverrides = { kind?: string; delivery?: unknown; source?: string; questId?: string; prompt?: string };

const job = (state: string, overrides: JobOverrides = {}) =>
  ({
    id: `job-${Math.random()}`,
    kind: overrides.kind ?? 'image',
    state,
    requestedBy: 'u1',
    source: overrides.source ?? 'agent',
    ...(overrides.delivery !== undefined && { delivery: overrides.delivery }),
    ...(overrides.questId && { questId: overrides.questId }),
    payload: { request: { prompt: overrides.prompt ?? 'A red kite' }, groupId: GROUP_ID },
  }) as unknown as GroupCompletion['anchor'];

const completion = (states: string[], overrides: JobOverrides = {}): GroupCompletion => {
  const members = states.map(state => job(state, overrides));
  return {
    groupId: GROUP_ID,
    members,
    anchor: members[0],
    readyCount: states.filter(state => state === 'succeeded').length,
    failedCount: states.filter(state => state === 'failed').length,
    cancelledCount: states.filter(state => state === 'cancelled').length,
    completedAt: new Date(),
  };
};

const makeDeps = () => {
  const deps = {
    connections: { findByUserId: vi.fn(async () => []) },
    appPathDeepLink: vi.fn((path: string) => `https://app.test${path}`),
    appRootDeepLink: vi.fn(() => 'https://app.test'),
    publish: vi.fn(async (_event: PushNotificationEvent) => {}),
    logger: { warn: vi.fn() },
  };
  return deps satisfies ImageGroupPushDeps;
};

let deps: ReturnType<typeof makeDeps>;
const deliver = (value: GroupCompletion) => imageGroupPushSubscriber(deps).deliver(value);

beforeEach(() => {
  pushDelivery.configured = true;
  deps = makeDeps();
});

describe('imageGroupPushSubscriber.wants', () => {
  const { wants } = imageGroupPushSubscriber(makeDeps());

  it('wants an image job with no delivery target', () => {
    expect(wants(job('succeeded'))).toBe(true);
  });

  it('does not want a non-image job', () => {
    expect(wants(job('succeeded', { kind: 'video' }))).toBe(false);
  });

  it('does not want an image job delivered elsewhere, such as Slack', () => {
    expect(wants(job('succeeded', { delivery: { kind: 'slack' } }))).toBe(false);
  });
});

describe('imageGroupPushSubscriber.deliver', () => {
  it('publishes nothing when push is not configured', async () => {
    pushDelivery.configured = false;
    await deliver(completion(['succeeded']));
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.connections.findByUserId).not.toHaveBeenCalled();
  });

  it('publishes nothing when no image was made', async () => {
    await deliver(completion(['failed', 'failed']));
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('publishes nothing while the user has a live browser connection', async () => {
    deps.connections.findByUserId.mockResolvedValue([{ source: 'web', authExpiresAt: FUTURE }] as never);
    await deliver(completion(['succeeded']));
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('still publishes when the only connection is stale or not a browser', async () => {
    deps.connections.findByUserId.mockResolvedValue([
      { source: 'web', authExpiresAt: new Date(Date.now() - 1000) },
      { source: 'cli', authExpiresAt: FUTURE },
    ] as never);
    await deliver(completion(['succeeded']));
    expect(deps.publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    [['succeeded'], 'Image ready'],
    [['succeeded', 'succeeded', 'succeeded'], '3 images ready'],
    [['succeeded', 'failed', 'succeeded'], '2 of 3 images ready'],
    [['succeeded', 'cancelled', 'succeeded'], '2 images ready'],
    [['succeeded', 'cancelled', 'failed'], '1 of 2 images ready'],
  ])('titles %j as %s', async (states, title) => {
    await deliver(completion(states));
    expect(deps.publish).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', category: 'generation_ready', title })
    );
  });

  it('uses the prompt as the body, collapsed and truncated', async () => {
    await deliver(completion(['succeeded'], { prompt: `  a\n  red   ${'kite '.repeat(60)}` }));
    const [event] = deps.publish.mock.calls[0] as [{ body: string }];
    expect(event.body.startsWith('a red kite')).toBe(true);
    expect(event.body.length).toBeLessThanOrEqual(160);
    expect(event.body.endsWith('...')).toBe(true);
  });

  it('falls back to a generic body when the prompt is blank', async () => {
    await deliver(completion(['succeeded'], { prompt: '   ' }));
    expect(deps.publish).toHaveBeenCalledWith(expect.objectContaining({ body: 'Your image is ready.' }));
    deps.publish.mockClear();
    await deliver(completion(['succeeded', 'succeeded'], { prompt: '   ' }));
    expect(deps.publish).toHaveBeenCalledWith(expect.objectContaining({ body: 'Your images are ready.' }));
  });

  it('deep links a Studio batch to its Studio completion page', async () => {
    await deliver(completion(['succeeded'], { source: 'studio' }));
    const path = studioCompletionLink('image', GROUP_ID);
    expect(deps.appPathDeepLink).toHaveBeenCalledWith(path);
    expect(deps.publish).toHaveBeenCalledWith(expect.objectContaining({ deepLink: `https://app.test${path}` }));
  });

  it('deep links any other source to the app root', async () => {
    await deliver(completion(['succeeded'], { source: 'agent' }));
    expect(deps.publish).toHaveBeenCalledWith(expect.objectContaining({ deepLink: 'https://app.test' }));
    expect(deps.appPathDeepLink).not.toHaveBeenCalled();
  });

  it('collapses the batch under one id and passes the quest id through', async () => {
    await deliver(completion(['succeeded', 'succeeded'], { questId: 'q1' }));
    expect(deps.publish).toHaveBeenCalledWith(
      expect.objectContaining({ collapseId: `generation:${GROUP_ID}`, questId: 'q1' })
    );
  });

  it('omits questId when the job has none', async () => {
    await deliver(completion(['succeeded']));
    expect(deps.publish.mock.calls[0][0]).not.toHaveProperty('questId');
  });
});

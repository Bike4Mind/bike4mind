import { describe, expect, it, vi } from 'vitest';
import type { StudioJobCompletedEvent } from '@bike4mind/common';
import { relayStudioJobCompleted } from './studioJobCompleted';

vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'https://ws.example' } } }));
vi.mock('@workers/utils/eventContext', () => ({ withEventContext: (handler: unknown) => handler }));

const event: StudioJobCompletedEvent = {
  version: 1,
  userId: 'u1',
  groupId: 'g1',
  medium: 'image',
  totalCount: 4,
  readyCount: 3,
  failedCount: 1,
  cancelledCount: 0,
  title: 'Cold brew launch',
  link: '/studio/image?group=g1',
  completedAt: '2026-11-12T10:00:00.000Z',
};

const makeLogger = () => ({ warn: vi.fn(), updateMetadata: vi.fn() });

describe('relayStudioJobCompleted', () => {
  it('sends the completion, without the recipient, to the requester', async () => {
    const relay = vi.fn(async () => undefined);
    await relayStudioJobCompleted(event, relay, makeLogger());

    const { userId: _userId, ...completion } = event;
    expect(relay).toHaveBeenCalledWith('u1', { action: 'studio_job_completed', completion });
  });

  it('drops a malformed event instead of throwing', async () => {
    const relay = vi.fn(async () => undefined);
    const logger = makeLogger();
    await relayStudioJobCompleted({ ...event, readyCount: -1 }, relay, logger);

    expect(relay).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('studio.job.completed event malformed; dropping', expect.anything());
  });

  it('lets a delivery failure throw so the event can be retried', async () => {
    const relay = vi.fn(async () => Promise.reject(new Error('gone')));
    await expect(relayStudioJobCompleted(event, relay, makeLogger())).rejects.toThrow('gone');
  });
});

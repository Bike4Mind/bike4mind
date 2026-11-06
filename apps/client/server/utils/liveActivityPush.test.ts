import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveActivityPushEvent } from '@bike4mind/common';

const h = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('./eventBus', () => ({ NotificationEvents: { LiveActivity: { publish: h.publish } } }));
const pushDelivery = vi.hoisted(() => ({ configured: true }));
vi.mock('@bike4mind/server-utils/utils/pushDelivery', () => ({
  isPushDeliveryConfigured: () => pushDelivery.configured,
}));

import { createLiveActivityThrottle, publishLiveActivityUpdate } from './liveActivityPush';

const update = (questId: string, status: string, extra: Partial<LiveActivityPushEvent['contentState']> = {}) =>
  ({
    userId: 'u1',
    questId,
    event: 'update',
    contentState: { status, ...extra },
  }) satisfies LiveActivityPushEvent;

const end = (questId: string): LiveActivityPushEvent => ({
  userId: 'u1',
  questId,
  event: 'end',
  contentState: { status: 'completed' },
});

describe('publishLiveActivityUpdate', () => {
  beforeEach(() => {
    h.publish.mockReset();
    pushDelivery.configured = true;
  });

  it('publishes nothing while push delivery is unconfigured', async () => {
    pushDelivery.configured = false;
    const warn = vi.fn();
    await publishLiveActivityUpdate(update('q1', 'running'), { warn });
    expect(h.publish).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('validates and publishes', async () => {
    h.publish.mockResolvedValue(undefined);
    await publishLiveActivityUpdate(update('q1', 'running'), { warn: vi.fn() });
    expect(h.publish).toHaveBeenCalledWith(update('q1', 'running'));
  });

  it('logs and swallows a publish failure', async () => {
    h.publish.mockRejectedValueOnce(new Error('bus down'));
    const warn = vi.fn();
    await expect(publishLiveActivityUpdate(update('q1', 'running'), { warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[LiveActivity] failed to publish live activity update',
      expect.objectContaining({ questId: 'q1', error: 'bus down' })
    );
  });

  it('swallows a schema violation instead of throwing into the host flow', async () => {
    const warn = vi.fn();
    const invalid = update('q1', 'running', { progress: 4 });
    await expect(publishLiveActivityUpdate(invalid, { warn })).resolves.toBeUndefined();
    expect(h.publish).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe('createLiveActivityThrottle', () => {
  const publish = vi.fn<(event: LiveActivityPushEvent) => Promise<void>>();

  beforeEach(() => {
    vi.useFakeTimers();
    publish.mockReset();
    publish.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it('collapses a burst to the leading frame plus the latest as the trailing frame', async () => {
    const throttle = createLiveActivityThrottle(publish, 15_000);
    await throttle.emit(update('q1', 'running', { stageLabel: 'a' }));
    await throttle.emit(update('q1', 'running', { stageLabel: 'b' }));
    await throttle.emit(update('q1', 'running', { stageLabel: 'c' }));
    expect(publish).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1][0].contentState.stageLabel).toBe('c');
  });

  it('skips the trailing flush when the latest state equals what was last sent', async () => {
    const throttle = createLiveActivityThrottle(publish, 15_000);
    await throttle.emit(update('q1', 'running', { stageLabel: 'a' }));
    await throttle.emit(update('q1', 'running', { stageLabel: 'b' }));
    await throttle.emit(update('q1', 'running', { stageLabel: 'a' }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('sends immediately again once the window has passed with nothing pending', async () => {
    const throttle = createLiveActivityThrottle(publish, 15_000);
    await throttle.emit(update('q1', 'running', { stageLabel: 'a' }));
    await vi.advanceTimersByTimeAsync(20_000);
    await throttle.emit(update('q1', 'running', { stageLabel: 'b' }));
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('opens a fresh window after a trailing flush', async () => {
    const throttle = createLiveActivityThrottle(publish, 15_000);
    await throttle.emit(update('q1', 'running', { stageLabel: 'a' }));
    await throttle.emit(update('q1', 'running', { stageLabel: 'b' }));
    await vi.advanceTimersByTimeAsync(15_000);
    await throttle.emit(update('q1', 'running', { stageLabel: 'c' }));
    expect(publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls[2][0].contentState.stageLabel).toBe('c');
  });

  it('sends end immediately and drops the pending update', async () => {
    const throttle = createLiveActivityThrottle(publish, 15_000);
    await throttle.emit(update('q1', 'running', { stageLabel: 'a' }));
    await throttle.emit(update('q1', 'running', { stageLabel: 'b' }));
    await throttle.emit(end('q1'));
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1][0].event).toBe('end');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('sends an immediate update inside the window and cancels the pending trailing frame', async () => {
    const throttle = createLiveActivityThrottle(publish, 15_000);
    await throttle.emit(update('q1', 'running', { stageLabel: 'a' }));
    await throttle.emit(update('q1', 'running', { stageLabel: 'b' }));
    await throttle.emit(update('q1', 'paused'), { immediate: true });
    expect(publish.mock.calls.map(([e]) => e.contentState.status)).toEqual(['running', 'paused']);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('sends end even as the first frame', async () => {
    const throttle = createLiveActivityThrottle(publish, 15_000);
    await throttle.emit(end('q1'));
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('throttles each quest independently', async () => {
    const throttle = createLiveActivityThrottle(publish, 15_000);
    await throttle.emit(update('q1', 'running', { stageLabel: 'a' }));
    await throttle.emit(update('q2', 'running', { stageLabel: 'a' }));
    expect(publish).toHaveBeenCalledTimes(2);

    await throttle.emit(update('q1', 'running', { stageLabel: 'b' }));
    await throttle.emit(end('q2'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publish.mock.calls.map(([e]) => [e.questId, e.event, e.contentState.stageLabel])).toEqual([
      ['q1', 'update', 'a'],
      ['q2', 'update', 'a'],
      ['q2', 'end', undefined],
      ['q1', 'update', 'b'],
    ]);
  });
});

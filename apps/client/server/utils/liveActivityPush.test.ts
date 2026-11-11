import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveActivityPushEvent } from '@bike4mind/common';

const h = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  NotificationEvents: { LiveActivity: { publish: h.publish } },
}));
const pushDelivery = vi.hoisted(() => ({ configured: true }));
vi.mock('@bike4mind/server-utils/utils/pushDelivery', () => ({
  isPushDeliveryConfigured: () => pushDelivery.configured,
}));

import {
  createLiveActivityThrottle,
  endAgentRunLiveActivity,
  LIVE_ACTIVITY_STALE_AFTER_MS,
  publishLiveActivityUpdate,
} from './liveActivityPush';

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

  it('validates and publishes, stamped with the publish time in unix seconds', async () => {
    h.publish.mockResolvedValue(undefined);
    await publishLiveActivityUpdate(update('q1', 'running'), { warn: vi.fn() }, 1_800_000_000_999);
    expect(h.publish).toHaveBeenCalledWith(
      expect.objectContaining({ ...update('q1', 'running'), timestamp: 1_800_000_000 })
    );
  });

  it('stamps a staleDate on an update unless the caller set one, and never on an end', async () => {
    h.publish.mockResolvedValue(undefined);
    const nowMs = 1_800_000_000_000;
    const staleAt = 1_800_000_000 + LIVE_ACTIVITY_STALE_AFTER_MS / 1000;
    await publishLiveActivityUpdate(update('q1', 'running'), { warn: vi.fn() }, nowMs);
    await publishLiveActivityUpdate({ ...update('q1', 'running'), staleDate: 42 }, { warn: vi.fn() }, nowMs);
    await publishLiveActivityUpdate(end('q1'), { warn: vi.fn() }, nowMs);
    const [stamped, supplied, ended] = h.publish.mock.calls.map(([e]) => e);
    expect(stamped.staleDate).toBe(staleAt);
    expect(supplied.staleDate).toBe(42);
    expect(ended.staleDate).toBeUndefined();
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

describe('endAgentRunLiveActivity', () => {
  beforeEach(() => {
    h.publish.mockReset();
    pushDelivery.configured = true;
  });

  it('publishes an end for a top-level run with a linked quest', async () => {
    await endAgentRunLiveActivity({ userId: 'u1', linkedQuestId: 'q1' }, { status: 'stopped' }, { warn: vi.fn() });
    expect(h.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        questId: 'q1',
        event: 'end',
        contentState: { status: 'stopped' },
      })
    );
  });

  it.each([
    { userId: 'u1' },
    { userId: 'u1', linkedQuestId: 'q1', parentExecutionId: 'parent' },
    { userId: 'u1', linkedQuestId: 'q1', spawnedByExecutionId: 'parent' },
    { userId: 'u1', linkedQuestId: 'q1', dagNodeId: 'node' },
  ])('skips runs without their own activity: %j', async execution => {
    await endAgentRunLiveActivity(execution, { status: 'completed' }, { warn: vi.fn() });
    expect(h.publish).not.toHaveBeenCalled();
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

  it('sends a repeated identical immediate update once', async () => {
    const throttle = createLiveActivityThrottle(publish, 15_000);
    await throttle.emit(update('q1', 'running', { stageLabel: 'a' }));
    await throttle.emit(update('q1', 'paused'), { immediate: true });
    await throttle.emit(update('q1', 'paused'), { immediate: true });
    expect(publish.mock.calls.map(([e]) => e.contentState.status)).toEqual(['running', 'paused']);
  });

  it('sends end even as the first frame', async () => {
    const throttle = createLiveActivityThrottle(publish, 15_000);
    await throttle.emit(end('q1'));
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('flush publishes the pending trailing frame now and cancels its timer', async () => {
    const throttle = createLiveActivityThrottle(publish, 15_000);
    await throttle.emit(update('q1', 'running', { stageLabel: 'a' }));
    await throttle.emit(update('q1', 'running', { stageLabel: 'b' }));
    await throttle.emit(update('q2', 'running', { stageLabel: 'a' }));

    await throttle.flush();
    expect(publish.mock.calls.map(([e]) => [e.questId, e.contentState.stageLabel])).toEqual([
      ['q1', 'a'],
      ['q2', 'a'],
      ['q1', 'b'],
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('flush waits for a publish already started by the trailing timer', async () => {
    const throttle = createLiveActivityThrottle(publish, 15_000);
    await throttle.emit(update('q1', 'running', { stageLabel: 'a' }));
    let resolvePublish!: () => void;
    publish.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          resolvePublish = resolve;
        })
    );
    await throttle.emit(update('q1', 'running', { stageLabel: 'b' }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publish).toHaveBeenCalledTimes(2);

    let flushed = false;
    const done = throttle.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    resolvePublish();
    await done;
    expect(flushed).toBe(true);
  });

  it('flush skips a pending frame equal to what was last sent', async () => {
    const throttle = createLiveActivityThrottle(publish, 15_000);
    await throttle.emit(update('q1', 'running', { stageLabel: 'a' }));
    await throttle.emit(update('q1', 'running', { stageLabel: 'a' }));
    await throttle.flush();
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

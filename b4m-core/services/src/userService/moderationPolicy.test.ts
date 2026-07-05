import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import {
  MODERATION_POLICY,
  countHitsWithinWindow,
  evaluateModerationPolicy,
  moderationThrottleKey,
  applyModerationHit,
} from './moderationPolicy';
import type { IModerationHit } from '@bike4mind/common';

const NOW = new Date('2026-07-03T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

describe('moderationPolicy - countHitsWithinWindow', () => {
  it('returns 0 for undefined/empty hits', () => {
    expect(countHitsWithinWindow(undefined, NOW)).toBe(0);
    expect(countHitsWithinWindow([], NOW)).toBe(0);
  });

  it('counts only hits within the rolling window', () => {
    const hits = [{ at: hoursAgo(1) }, { at: hoursAgo(23) }, { at: hoursAgo(25) }, { at: hoursAgo(48) }];
    // Default 24h window: the 25h and 48h old hits fall outside.
    expect(countHitsWithinWindow(hits, NOW)).toBe(2);
  });

  it('includes a hit exactly on the window boundary', () => {
    const hits = [{ at: new Date(NOW.getTime() - MODERATION_POLICY.windowMs) }];
    expect(countHitsWithinWindow(hits, NOW)).toBe(1);
  });

  it('honors a custom window', () => {
    const hits = [{ at: hoursAgo(1) }, { at: hoursAgo(2) }];
    expect(countHitsWithinWindow(hits, NOW, 90 * 60 * 1000)).toBe(1);
  });
});

describe('moderationPolicy - evaluateModerationPolicy', () => {
  it('does nothing below the throttle threshold', () => {
    expect(evaluateModerationPolicy(0)).toBe('none');
    expect(evaluateModerationPolicy(MODERATION_POLICY.throttleAt - 1)).toBe('none');
  });

  it('throttles at the throttle threshold', () => {
    expect(evaluateModerationPolicy(MODERATION_POLICY.throttleAt)).toBe('throttle');
    expect(evaluateModerationPolicy(MODERATION_POLICY.suspendAt - 1)).toBe('throttle');
  });

  it('flags for suspension at the suspend threshold', () => {
    expect(evaluateModerationPolicy(MODERATION_POLICY.suspendAt)).toBe('suspend_pending');
    expect(evaluateModerationPolicy(MODERATION_POLICY.suspendAt + 10)).toBe('suspend_pending');
  });
});

describe('moderationPolicy - moderationThrottleKey', () => {
  it('is namespaced per user', () => {
    expect(moderationThrottleKey('user-1')).toBe('moderation-throttle:user-1');
  });
});

describe('moderationPolicy - applyModerationHit', () => {
  let users: { recordModerationHit: Mock; setModerationStatus: Mock };
  const hit: IModerationHit = { at: NOW, categories: ['hate'], source: 'openai', questId: 'q-1' };

  // recordModerationHit returns a user whose in-window hit log has `count` entries at NOW.
  const userWith = (
    count: number,
    status: 'active' | 'throttled' | 'suspend_pending' | 'suspended' = 'active',
    throttledUntil: Date | null = null
  ) => ({
    id: 'user-1',
    moderation: { hits: Array.from({ length: count }, () => ({ at: NOW })), status, throttledUntil },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    users = { recordModerationHit: vi.fn(), setModerationStatus: vi.fn() };
  });

  it('takes no escalation action below the throttle threshold', async () => {
    users.recordModerationHit.mockResolvedValue(userWith(MODERATION_POLICY.throttleAt - 1));

    const result = await applyModerationHit({ users, userId: 'user-1', hit, now: NOW });

    expect(users.recordModerationHit).toHaveBeenCalledWith('user-1', hit);
    expect(users.setModerationStatus).not.toHaveBeenCalled();
    expect(result).toMatchObject({ action: 'none', status: 'active' });
  });

  it('auto-throttles at the throttle threshold with a throttledUntil deadline', async () => {
    users.recordModerationHit.mockResolvedValue(userWith(MODERATION_POLICY.throttleAt));

    const result = await applyModerationHit({ users, userId: 'user-1', hit, now: NOW });

    expect(users.setModerationStatus).toHaveBeenCalledWith('user-1', 'throttled', {
      throttledUntil: new Date(NOW.getTime() + MODERATION_POLICY.throttleDurationMs),
    });
    expect(result).toMatchObject({ action: 'throttle', status: 'throttled' });
  });

  it('flags for suspension at the suspend threshold (no throttledUntil)', async () => {
    users.recordModerationHit.mockResolvedValue(userWith(MODERATION_POLICY.suspendAt));

    const result = await applyModerationHit({ users, userId: 'user-1', hit, now: NOW });

    expect(users.setModerationStatus).toHaveBeenCalledWith('user-1', 'suspend_pending', { throttledUntil: null });
    expect(result).toMatchObject({ action: 'suspend_pending', status: 'suspend_pending' });
  });

  it('does not re-arm a throttle that is still active (avoids resetting the window on every hit)', async () => {
    // Already throttled, throttle still in force -> a fresh throttle-level hit must not reset it.
    const future = new Date(NOW.getTime() + 60 * 60 * 1000);
    users.recordModerationHit.mockResolvedValue(userWith(MODERATION_POLICY.throttleAt, 'throttled', future));

    const result = await applyModerationHit({ users, userId: 'user-1', hit, now: NOW });

    expect(users.setModerationStatus).not.toHaveBeenCalled();
    expect(result.status).toBe('throttled');
  });

  it('re-arms an expired throttle on a repeat offense in a new window', async () => {
    // Status still 'throttled' but the window lapsed; a fresh threshold breach must re-throttle.
    const past = new Date(NOW.getTime() - 60 * 60 * 1000);
    users.recordModerationHit.mockResolvedValue(userWith(MODERATION_POLICY.throttleAt, 'throttled', past));

    const result = await applyModerationHit({ users, userId: 'user-1', hit, now: NOW });

    expect(users.setModerationStatus).toHaveBeenCalledWith('user-1', 'throttled', {
      throttledUntil: new Date(NOW.getTime() + MODERATION_POLICY.throttleDurationMs),
    });
    expect(result.status).toBe('throttled');
  });

  it('escalates an expired-throttle user straight to suspend_pending at the suspend threshold', async () => {
    const past = new Date(NOW.getTime() - 60 * 60 * 1000);
    users.recordModerationHit.mockResolvedValue(userWith(MODERATION_POLICY.suspendAt, 'throttled', past));

    const result = await applyModerationHit({ users, userId: 'user-1', hit, now: NOW });

    expect(users.setModerationStatus).toHaveBeenCalledWith('user-1', 'suspend_pending', { throttledUntil: null });
    expect(result.status).toBe('suspend_pending');
  });

  it('does not downgrade a suspend_pending user back to throttled', async () => {
    // Enough hits to throttle, but the user is already flagged for suspension.
    users.recordModerationHit.mockResolvedValue(userWith(MODERATION_POLICY.throttleAt, 'suspend_pending'));

    const result = await applyModerationHit({ users, userId: 'user-1', hit, now: NOW });

    expect(users.setModerationStatus).not.toHaveBeenCalled();
    expect(result.status).toBe('suspend_pending');
  });

  it('never re-touches a human-confirmed suspended account from the automated path', async () => {
    users.recordModerationHit.mockResolvedValue(userWith(MODERATION_POLICY.suspendAt, 'suspended'));

    const result = await applyModerationHit({ users, userId: 'user-1', hit, now: NOW });

    expect(users.setModerationStatus).not.toHaveBeenCalled();
    expect(result.status).toBe('suspended');
  });

  it('treats a missing moderation subdocument as active', async () => {
    users.recordModerationHit.mockResolvedValue({ id: 'user-1' });

    const result = await applyModerationHit({ users, userId: 'user-1', hit, now: NOW });

    expect(result).toMatchObject({ hitsInWindow: 0, action: 'none', status: 'active' });
  });
});

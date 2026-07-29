import { describe, expect, it } from 'vitest';
import { presenceStateForReason } from '@bike4mind/database';
import type { HearthEvent } from '@bike4mind/hearth';
import { toPresenceProjection } from '../hearthWire';

/**
 * The projection had no test of its own; it was only reached indirectly through
 * the events route, which is why the tier 0/1 case below went unnoticed.
 */
const EVENT: HearthEvent = {
  id: 'ev-1',
  channelId: 'ch-1',
  seq: 1,
  actorId: 'actor-1',
  kind: 'presence',
  human: { text: 'x', format: 'text' },
  machine: undefined,
  refs: {},
  createdAt: new Date('2026-07-28T00:00:00Z'),
};

const project = (payload: unknown) => toPresenceProjection({ event: EVENT, userId: 'u1', payload });

/** What the roster row actually ends up saying, which is the claim that matters. */
const stateOf = (payload: unknown) => presenceStateForReason(project(payload)?.reason);

describe('toPresenceProjection', () => {
  it('reads the reason from the activity block at tier 2', () => {
    const row = project({
      hook_event_name: 'Notification',
      session_id: 's-1',
      slug: 'calm-otter',
      workspace: 'some-repo',
      activity: { reason: 'permission_prompt', tool: 'Bash' },
    });

    expect(row?.reason).toBe('permission_prompt');
    expect(row?.tool).toBe('Bash');
    expect(stateOf({ activity: { reason: 'permission_prompt' } })).toBe('awaiting_permission');
  });

  // The bug this file exists for. The hook attaches `activity` ONLY at disclosure
  // tier 2 but writes hook_event_name at every tier, so reading activity.reason
  // alone left reason undefined below tier 2 - and an undefined reason projects
  // to `running`. A tier 0 or 1 session that ENDED therefore recorded a
  // live-looking row that no later event ever corrected.
  it('derives the reason from the event name when no activity block arrived', () => {
    const tierZeroSessionEnd = { hook_event_name: 'SessionEnd', session_id: 's-1', slug: 'calm-otter' };

    expect(project(tierZeroSessionEnd)?.reason).toBe('session_end');
    expect(stateOf(tierZeroSessionEnd)).toBe('disconnected');
  });

  it('derives every other lifecycle state at tier 0 too', () => {
    expect(stateOf({ hook_event_name: 'SessionStart' })).toBe('running');
    expect(stateOf({ hook_event_name: 'Stop' })).toBe('idle');
    expect(stateOf({ hook_event_name: 'PreToolUse' })).toBe('running');
  });

  it('prefers the activity reason over the event name when both are present', () => {
    // The activity block is the more specific signal: a Notification's
    // notification_type distinguishes a permission prompt from an idle nudge,
    // which the event name alone cannot.
    const row = project({ hook_event_name: 'Notification', activity: { reason: 'permission_prompt' } });
    expect(row?.reason).toBe('permission_prompt');
  });

  it('falls back to a generic reason for an event name it does not know', () => {
    expect(project({ hook_event_name: 'SomeFutureHook' })?.reason).toBe('active');
    // Unknown reasons must not escalate: `active` is not in REASON_STATES, so it
    // lands on the neutral default rather than claiming the human's attention.
    expect(stateOf({ hook_event_name: 'SomeFutureHook' })).toBe('running');
  });

  it('still projects a bare payload rather than dropping the update', () => {
    // Losing a whole presence update because a payload carried no detail is the
    // worse failure: lastSeen is the minimum useful signal.
    const row = project({});
    expect(row).not.toBeNull();
    expect(row?.lastSeen).toEqual(EVENT.createdAt);
    expect(row?.reason).toBe('active');
  });

  it('uses the event time, not the write time', () => {
    expect(project({ hook_event_name: 'Stop' })?.lastSeen).toEqual(EVENT.createdAt);
  });

  it('truncates over-long fields instead of rejecting the update', () => {
    const row = project({ workspace: 'w'.repeat(500), activity: { reason: 'r'.repeat(500) } });
    expect(row?.workspace).toHaveLength(200);
    expect(row?.reason).toHaveLength(200);
  });

  it('returns null for a payload shape it cannot read at all', () => {
    expect(project('not an object')).toBeNull();
    expect(project(42)).toBeNull();
  });
});

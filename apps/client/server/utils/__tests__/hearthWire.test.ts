import { beforeEach, describe, expect, it, vi } from 'vitest';
import { presenceStateForReason } from '@bike4mind/database';
import { sessionSlug, type HearthEvent } from '@bike4mind/hearth';
import { resolveRequestActor, toPresenceProjection } from '../hearthWire';

const { ensureActorMock } = vi.hoisted(() => ({ ensureActorMock: vi.fn() }));

// Only ensureActor is faked; presenceStateForReason below is the real one, since
// the projection tests assert against the actual reason-to-state table.
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    hearthRepository: { ...actual.hearthRepository, ensureActor: ensureActorMock },
  };
});

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

describe('resolveRequestActor', () => {
  const USER = { id: 'u1', username: 'erik', email: 'erik@example.com' };

  beforeEach(() => {
    ensureActorMock.mockReset();
    ensureActorMock.mockResolvedValue({ _id: { toString: () => 'actor-1' } });
  });

  const identityArgs = () => ensureActorMock.mock.calls[0];

  it('names the human from the account when no session is supplied', async () => {
    await resolveRequestActor(USER, undefined, undefined);
    expect(identityArgs()).toEqual(['u1', 'human', 'erik']);
  });

  /**
   * The regression guard for the shared-cursor defect: identity must vary by
   * session, because actor identity IS the cursor key. Before this, every CLI
   * session of one user collapsed onto a single actor and they consumed each
   * other's catchup events.
   */
  it('derives a distinct identity per session', async () => {
    await resolveRequestActor(USER, undefined, { id: 'session-a' });
    const first = identityArgs()[2];
    ensureActorMock.mockReset();
    ensureActorMock.mockResolvedValue({ _id: { toString: () => 'actor-2' } });
    await resolveRequestActor(USER, undefined, { id: 'session-b' });
    const second = identityArgs()[2];

    expect(first).toBe(`erik (${sessionSlug('session-a')})`);
    expect(second).toBe(`erik (${sessionSlug('session-b')})`);
    expect(first).not.toBe(second);
  });

  it('keeps a renameable label OUT of the identity key and in displayLabel', async () => {
    await resolveRequestActor(USER, undefined, { id: 'session-a', label: 'planning notebook' });

    const [, , identity, options] = identityArgs();
    // Identity uses the stable slug, so an auto-title or rename cannot mint a
    // new actor (and a new cursor) mid-session.
    expect(identity).toBe(`erik (${sessionSlug('session-a')})`);
    expect(options).toEqual({ displayLabel: 'erik (planning notebook)' });
  });

  it('never lets a label occupy the position that reads as who the actor is', async () => {
    await resolveRequestActor(USER, undefined, { id: 'session-a', label: ') admin (' });

    const label = identityArgs()[3].displayLabel;
    expect(label).toBe('erik (admin)');
    expect(label.startsWith('erik ')).toBe(true);
  });

  it('lets a machine name itself and ignores any session for it', async () => {
    await resolveRequestActor(USER, { kind: 'agent', displayName: 'Claude Code (teal-lynx)' }, { id: 'session-a' });
    expect(identityArgs()).toEqual(['u1', 'agent', 'Claude Code (teal-lynx)']);
  });

  it('falls back to the email, then a constant, when there is no username', async () => {
    await resolveRequestActor({ id: 'u1', email: 'erik@example.com' }, undefined, undefined);
    expect(identityArgs()[2]).toBe('erik@example.com');
    ensureActorMock.mockReset();
    ensureActorMock.mockResolvedValue({ _id: { toString: () => 'a' } });
    await resolveRequestActor({ id: 'u1' }, undefined, undefined);
    expect(identityArgs()[2]).toBe('user');
  });
});

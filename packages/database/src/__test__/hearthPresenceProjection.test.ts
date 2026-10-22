import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { connectTestDB, disconnectTestDB, cleanupTestDB } from './utils';
import { CcAgentStatus } from '@bike4mind/common';
import {
  HearthPresence,
  presenceStateForReason,
  PRESENCE_STALE_AFTER_MS,
  PRESENCE_STATE_RANK,
} from '../models/hearth/HearthPresenceModel';
import { hearthRepository, MAX_ROSTER_ROWS } from '../models/hearth/MongoHearthStore';

describe('Hearth presence projection', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await connectTestDB();
    // The unique (channelId, actorId) index is load-bearing here: it is what
    // turns a late event's upsert into a no-op instead of a second row.
    await HearthPresence.ensureIndexes();
  }, 30000);

  afterAll(async () => {
    if (mongoServer) await disconnectTestDB(mongoServer);
  }, 30000);

  beforeEach(async () => {
    await cleanupTestDB();
    await HearthPresence.ensureIndexes();
  });

  const USER = '6540b58d1f703ade3ea1e82b';
  const OTHER_USER = '6540b58d1f703ade3ea1e82c';

  async function setup(actorName = 'Claude Code (amber-otter)') {
    const channel = await hearthRepository.createChannel(USER, 'general');
    const actor = await hearthRepository.ensureActor(USER, 'agent', actorName);
    return { channelId: channel._id.toString(), actorId: actor._id.toString() };
  }

  function presence(channelId: string, actorId: string, lastSeen: Date, reason: string, extra = {}) {
    return { channelId, actorId, userId: USER, lastSeen, reason, ...extra };
  }

  it('maps every reason group onto its state', () => {
    // A halted session and a session asking a question are DIFFERENT states:
    // conflating them is what made the term ambiguous across surfaces.
    expect(presenceStateForReason('permission_prompt')).toBe('awaiting_permission');

    expect(presenceStateForReason('idle_prompt')).toBe('awaiting_input');
    expect(presenceStateForReason('agent_needs_input')).toBe('awaiting_input');
    expect(presenceStateForReason('elicitation_dialog')).toBe('awaiting_input');

    expect(presenceStateForReason('turn_finished')).toBe('idle');
    expect(presenceStateForReason('agent_completed')).toBe('idle');
    // Gone, not merely quiet.
    expect(presenceStateForReason('session_end')).toBe('disconnected');

    expect(presenceStateForReason('tool_use')).toBe('running');
    expect(presenceStateForReason('prompt_submitted')).toBe('running');
    expect(presenceStateForReason('session_start')).toBe('running');
    expect(presenceStateForReason('active')).toBe('running');
    expect(presenceStateForReason('auth_success')).toBe('running');
    expect(presenceStateForReason('elicitation_complete')).toBe('running');

    // An unknown reason must not claim your attention, nor vanish as idle.
    expect(presenceStateForReason('some_future_reason')).toBe('running');
    expect(presenceStateForReason(undefined)).toBe('running');
  });

  it('maps every code-agent status onto itself', () => {
    // The cc-bridge reports CcAgentStatus values as the reason, so each must map
    // to the identical state. Without these the default would win and a
    // disconnected or idle bridge session would show up as running - a roster
    // reporting dead sessions as working is worse than no roster.
    for (const status of CcAgentStatus.options) {
      expect(presenceStateForReason(status), status).toBe(status);
    }
  });

  it('states are exactly the shared code-agent status vocabulary', () => {
    // Guards the whole point of the pivot: if someone adds a roster-only state
    // here, or the shared enum grows a value the ranking does not cover, this
    // fails rather than letting the two vocabularies drift apart silently.
    expect(Object.keys(PRESENCE_STATE_RANK).sort()).toEqual([...CcAgentStatus.options].sort());
  });

  it('ranks the most-blocking state first', () => {
    const byRank = (Object.keys(PRESENCE_STATE_RANK) as Array<keyof typeof PRESENCE_STATE_RANK>).sort(
      (a, b) => PRESENCE_STATE_RANK[a] - PRESENCE_STATE_RANK[b]
    );
    // Permission outranks a question: it halts execution outright.
    expect(byRank).toEqual(['awaiting_permission', 'awaiting_input', 'running', 'idle', 'disconnected']);
  });

  it('creates exactly one row per (channel, actor) and updates it in place', async () => {
    const { channelId, actorId } = await setup();

    const first = await hearthRepository.upsertPresence(
      presence(channelId, actorId, new Date('2026-07-27T10:00:00Z'), 'tool_use', { tool: 'Bash' })
    );
    expect(first?.state).toBe('running');
    expect(first?.tool).toBe('Bash');

    const second = await hearthRepository.upsertPresence(
      presence(channelId, actorId, new Date('2026-07-27T10:00:05Z'), 'permission_prompt', { tool: 'Write' })
    );

    expect(await HearthPresence.countDocuments({})).toBe(1);
    expect(second?._id.toString()).toBe(first?._id.toString());
    expect(second?.state).toBe('awaiting_permission');
    expect(second?.tool).toBe('Write');
  });

  it('projects a bridge-reported status onto the matching roster row', async () => {
    const { channelId, actorId } = await setup('bluebike4mind (amber-otter)');

    // What the cc-bridge handlers pass: the status value as the reason, plus the
    // session id and slug. The state must equal the reported status exactly.
    const blocked = await hearthRepository.upsertPresence(
      presence(channelId, actorId, new Date('2026-07-27T10:00:00Z'), 'awaiting_permission', {
        workspace: 'bluebike4mind',
        sessionId: 'a67cd606-80f3-459d-88b5-3df6d3c11a31',
        slug: 'amber-otter',
      })
    );
    expect(blocked?.state).toBe('awaiting_permission');
    expect(blocked?.slug).toBe('amber-otter');

    const working = await hearthRepository.upsertPresence(
      presence(channelId, actorId, new Date('2026-07-27T10:00:05Z'), 'running', { workspace: 'bluebike4mind' })
    );
    expect(working?.state).toBe('running');

    // A session that ends must read as gone, not as still working.
    const gone = await hearthRepository.upsertPresence(
      presence(channelId, actorId, new Date('2026-07-27T10:00:09Z'), 'disconnected', { workspace: 'bluebike4mind' })
    );
    expect(gone?.state).toBe('disconnected');
    expect(await HearthPresence.countDocuments({})).toBe(1);
  });

  it('clears detail the newer event no longer reports', async () => {
    const { channelId, actorId } = await setup();

    await hearthRepository.upsertPresence(
      presence(channelId, actorId, new Date('2026-07-27T10:00:00Z'), 'permission_prompt', {
        tool: 'Bash',
        workspace: 'some-repo',
        subagent: 'Explore',
      })
    );
    const after = await hearthRepository.upsertPresence(
      presence(channelId, actorId, new Date('2026-07-27T10:00:05Z'), 'turn_finished', { workspace: 'some-repo' })
    );

    // A finished turn is not still running Bash inside a subagent.
    expect(after?.tool).toBeUndefined();
    expect(after?.subagent).toBeUndefined();
    expect(after?.workspace).toBe('some-repo');
  });

  it('never lets a late event move a row backwards', async () => {
    const { channelId, actorId } = await setup();

    await hearthRepository.upsertPresence(
      presence(channelId, actorId, new Date('2026-07-27T10:00:10Z'), 'permission_prompt')
    );

    // Replayed / delayed older event: dropped, not applied.
    const late = await hearthRepository.upsertPresence(
      presence(channelId, actorId, new Date('2026-07-27T10:00:00Z'), 'session_end')
    );
    expect(late).toBeNull();

    const row = await HearthPresence.findOne({});
    expect(row?.state).toBe('awaiting_permission');
    expect(row?.lastSeen.toISOString()).toBe('2026-07-27T10:00:10.000Z');
    expect(await HearthPresence.countDocuments({})).toBe(1);
  });

  it('orders fresh rows needs-you-first, most recent within a state', async () => {
    const channel = await hearthRepository.createChannel(USER, 'general');
    const channelId = channel._id.toString();

    const actors = await Promise.all(
      ['idle-old', 'working-old', 'working-one', 'blocked-old', 'blocked-new'].map(name =>
        hearthRepository.ensureActor(USER, 'agent', name)
      )
    );
    const [idleOld, workingOld, workingOne, blockedOld, blockedNew] = actors.map(a => a._id.toString());

    await hearthRepository.upsertPresence(
      presence(channelId, idleOld, new Date('2026-07-27T10:00:30Z'), 'turn_finished')
    );
    // The running pair is inserted oldest-first. With the recency key dropped,
    // their tie order is unspecified, so the assertion below usually catches it.
    await hearthRepository.upsertPresence(
      presence(channelId, workingOld, new Date('2026-07-27T10:00:15Z'), 'tool_use')
    );
    await hearthRepository.upsertPresence(
      presence(channelId, workingOne, new Date('2026-07-27T10:00:20Z'), 'tool_use')
    );
    await hearthRepository.upsertPresence(
      presence(channelId, blockedOld, new Date('2026-07-27T10:00:05Z'), 'permission_prompt')
    );
    await hearthRepository.upsertPresence(
      presence(channelId, blockedNew, new Date('2026-07-27T10:00:10Z'), 'agent_needs_input')
    );

    // Pinned a minute after the events so every row is inside the stale window:
    // this test is about the fresh tier, not about demotion by age.
    const roster = await hearthRepository.presenceForChannel(USER, channelId, {
      now: new Date('2026-07-27T10:01:00Z'),
    });
    // Both blocked actors outrank the more recently seen running and idle rows,
    // AND the permission block outranks the question despite being seen EARLIER -
    // state ranking dominates recency, because a halted session is the thing
    // most in need of the human. Within the running pair, recency decides.
    expect(roster.map(r => r.actorId.toString())).toEqual([blockedOld, blockedNew, workingOne, workingOld, idleOld]);
    expect(roster.map(r => r.state)).toEqual(['awaiting_permission', 'awaiting_input', 'running', 'running', 'idle']);
  });

  it('ranks a stale awaiting_permission row below fresh rows', async () => {
    const channel = await hearthRepository.createChannel(USER, 'general');
    const channelId = channel._id.toString();
    const [expired, live] = (
      await Promise.all(['expired', 'live'].map(n => hearthRepository.ensureActor(USER, 'agent', n)))
    ).map(a => a._id.toString());
    const now = new Date('2026-07-27T10:20:00Z');

    await hearthRepository.upsertPresence(
      presence(channelId, expired, new Date(now.getTime() - 16 * 60_000), 'permission_prompt')
    );
    await hearthRepository.upsertPresence(presence(channelId, live, new Date(now.getTime() - 30_000), 'tool_use'));

    const roster = await hearthRepository.presenceForChannel(USER, channelId, { now });
    expect(roster.map(r => r.actorId.toString())).toEqual([live, expired]);
    expect(roster.map(r => r.state)).toEqual(['running', 'awaiting_permission']);
    expect(roster[0]).not.toHaveProperty('isStale');
  });

  it('measures staleness against the wall clock when no now is passed', async () => {
    // The presence route never passes `now`, so the default branch is the only
    // path production takes. The margins are wide enough that a slow run cannot
    // cross the window.
    const channel = await hearthRepository.createChannel(USER, 'general');
    const channelId = channel._id.toString();
    const [expired, live] = (
      await Promise.all(['wall-expired', 'wall-live'].map(n => hearthRepository.ensureActor(USER, 'agent', n)))
    ).map(a => a._id.toString());

    await hearthRepository.upsertPresence(
      presence(channelId, expired, new Date(Date.now() - 16 * 60_000), 'permission_prompt')
    );
    await hearthRepository.upsertPresence(presence(channelId, live, new Date(Date.now() - 10_000), 'tool_use'));

    const roster = await hearthRepository.presenceForChannel(USER, channelId);
    expect(roster.map(r => r.actorId.toString())).toEqual([live, expired]);
  });

  it('keeps state ranking among stale rows', async () => {
    const channel = await hearthRepository.createChannel(USER, 'general');
    const channelId = channel._id.toString();
    const [idle, blocked] = (
      await Promise.all(['idle', 'blocked'].map(n => hearthRepository.ensureActor(USER, 'agent', n)))
    ).map(a => a._id.toString());
    const now = new Date('2026-07-27T10:20:00Z');

    await hearthRepository.upsertPresence(
      presence(channelId, idle, new Date(now.getTime() - 20 * 60_000), 'turn_finished')
    );
    await hearthRepository.upsertPresence(
      presence(channelId, blocked, new Date(now.getTime() - 30 * 60_000), 'permission_prompt')
    );

    const roster = await hearthRepository.presenceForChannel(USER, channelId, { now });
    expect(roster.map(r => r.actorId.toString())).toEqual([blocked, idle]);
  });

  it('keeps the most-blocked session first among fresh rows', async () => {
    const channel = await hearthRepository.createChannel(USER, 'general');
    const channelId = channel._id.toString();
    const [blocked, working] = (
      await Promise.all(['fresh-blocked', 'fresh-working'].map(n => hearthRepository.ensureActor(USER, 'agent', n)))
    ).map(a => a._id.toString());
    const now = new Date('2026-07-27T10:20:00Z');

    await hearthRepository.upsertPresence(
      presence(channelId, blocked, new Date(now.getTime() - 20_000), 'permission_prompt')
    );
    await hearthRepository.upsertPresence(presence(channelId, working, new Date(now.getTime() - 5_000), 'tool_use'));

    const roster = await hearthRepository.presenceForChannel(USER, channelId, { now });
    // Both fresh, so state rank still decides - freshness only demotes rows
    // that stopped reporting.
    expect(roster.map(r => r.actorId.toString())).toEqual([blocked, working]);
  });

  it('counts a row exactly at the stale window as fresh, one ms older as stale', async () => {
    const channel = await hearthRepository.createChannel(USER, 'general');
    const channelId = channel._id.toString();
    const [atWindow, justPast] = (
      await Promise.all(['at-window', 'just-past'].map(n => hearthRepository.ensureActor(USER, 'agent', n)))
    ).map(a => a._id.toString());
    const now = new Date('2026-07-27T10:20:00Z');
    const boundary = new Date(now.getTime() - PRESENCE_STALE_AFTER_MS);

    // The boundary row deliberately holds the LOWER-priority state, so it can
    // only lead while it counts as fresh. If the comparison became inclusive,
    // both rows would be stale and state rank would put the permission row
    // first - this assertion is the one that pins the strict `$lt`.
    await hearthRepository.upsertPresence(presence(channelId, atWindow, boundary, 'tool_use'));
    await hearthRepository.upsertPresence(
      presence(channelId, justPast, new Date(boundary.getTime() - 1), 'permission_prompt')
    );

    const roster = await hearthRepository.presenceForChannel(USER, channelId, { now });
    expect(roster.map(r => r.actorId.toString())).toEqual([atWindow, justPast]);
  });

  it('scopes the roster to the owning user', async () => {
    const { channelId, actorId } = await setup();
    await hearthRepository.upsertPresence(presence(channelId, actorId, new Date(), 'tool_use'));

    expect(await hearthRepository.presenceForChannel(USER, channelId)).toHaveLength(1);
    expect(await hearthRepository.presenceForChannel(OTHER_USER, channelId)).toHaveLength(0);
  });

  describe('prototype-named reasons', () => {
    /**
     * `reason` reaches here from any hearth:write caller via activity.reason and
     * is only length-clamped, so the lookup table must not expose
     * Object.prototype. Before the null-prototype table: 'constructor' returned
     * the Object function (truthy, so it beat the 'running' default) and
     * persisted a state outside the declared enum, because findOneAndUpdate does
     * not run validators; '__proto__' threw a CastError that upsertPresence did
     * not swallow, dropping the roster update entirely.
     */
    it('falls back to running instead of reading through the prototype', () => {
      for (const reason of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
        expect(presenceStateForReason(reason)).toBe('running');
      }
    });

    it('still writes a valid enum state for a prototype-named reason', async () => {
      const { channelId, actorId } = await setup();

      const row = await hearthRepository.upsertPresence(
        presence(channelId, actorId, new Date('2026-07-29T00:00:00Z'), 'constructor')
      );

      expect(row?.state).toBe('running');
      expect(Object.keys(PRESENCE_STATE_RANK)).toContain(row?.state);
    });

    it('does not drop the roster update for a __proto__ reason', async () => {
      const { channelId, actorId } = await setup();

      const row = await hearthRepository.upsertPresence(
        presence(channelId, actorId, new Date('2026-07-29T00:00:00Z'), '__proto__')
      );

      // Previously a CastError propagated out of upsertPresence and the caller
      // logged a failed projection, so the actor never appeared in the roster.
      expect(row).not.toBeNull();
      expect(await hearthRepository.presenceForChannel(USER, channelId)).toHaveLength(1);
    });
  });

  describe('concurrent first write', () => {
    /**
     * With no row yet, two in-flight events both miss the $lt filter and both try
     * to insert; the loser used to be read as "too old" and discarded. When the
     * loser was the NEWER event, the row kept the older state - so a session that
     * became blocked in the same instant it first appeared showed as working.
     */
    it('keeps the newer state when two first-events race', async () => {
      const { channelId, actorId } = await setup();
      const older = new Date('2026-07-29T00:00:00Z');
      const newer = new Date('2026-07-29T00:00:05Z');

      const results = await Promise.all([
        hearthRepository.upsertPresence(presence(channelId, actorId, older, 'tool_use')),
        hearthRepository.upsertPresence(presence(channelId, actorId, newer, 'permission_prompt')),
      ]);

      // Exactly one row, and it reflects the newer event regardless of who won.
      const roster = await hearthRepository.presenceForChannel(USER, channelId);
      expect(roster).toHaveLength(1);
      expect(roster[0].state).toBe('awaiting_permission');
      expect(roster[0].lastSeen.toISOString()).toBe(newer.toISOString());
      // Both calls resolve; the genuinely-stale one returns null rather than throwing.
      expect(results.some(r => r !== null)).toBe(true);
    });

    it('still reports a genuinely stale event as stale', async () => {
      const { channelId, actorId } = await setup();
      await hearthRepository.upsertPresence(
        presence(channelId, actorId, new Date('2026-07-29T00:00:05Z'), 'permission_prompt')
      );

      const stale = await hearthRepository.upsertPresence(
        presence(channelId, actorId, new Date('2026-07-29T00:00:00Z'), 'tool_use')
      );

      expect(stale).toBeNull();
      expect((await hearthRepository.presenceForChannel(USER, channelId))[0].state).toBe('awaiting_permission');
    });
  });

  describe('roster bound', () => {
    /**
     * Actors are minted one per session by design and nothing deletes a presence
     * row (the retention TTL covers events, not this projection), so an aged
     * account accretes rows in the one shared default channel forever. The sort
     * runs on an $addFields key no index can serve, so without a cap every read
     * is an in-memory sort proportional to lifetime session count.
     */
    it('caps returned rows and keeps the most urgent of the fresh ones', async () => {
      const channel = await hearthRepository.createChannel(USER, 'agents');
      const channelId = channel._id.toString();
      const now = new Date('2026-07-29T00:01:00Z');

      // One more than the cap, all idle and fresh except a single blocked actor
      // created LAST (so insertion order cannot be what puts it first).
      for (let i = 0; i < MAX_ROSTER_ROWS; i++) {
        const actor = await hearthRepository.ensureActor(USER, 'agent', `filler-${i}`);
        await hearthRepository.upsertPresence(
          presence(channelId, actor._id.toString(), new Date('2026-07-29T00:00:00Z'), 'turn_finished')
        );
      }
      const blocked = await hearthRepository.ensureActor(USER, 'agent', 'blocked');
      await hearthRepository.upsertPresence(
        presence(channelId, blocked._id.toString(), new Date('2026-07-29T00:00:01Z'), 'permission_prompt')
      );

      const roster = await hearthRepository.presenceForChannel(USER, channelId, { now });

      expect(roster).toHaveLength(MAX_ROSTER_ROWS);
      // Among these fresh rows, ranking happens BEFORE the limit, so truncation
      // drops the least urgent ones rather than whichever the scan reached last.
      expect(roster[0].actorId.toString()).toBe(blocked._id.toString());
      expect(roster[0].state).toBe('awaiting_permission');
    }, 60000);

    it('drops a stale row before fresh ones when the roster is capped', async () => {
      // Freshness is the first sort key, so a stale awaiting_permission row is
      // the first casualty of the cap - the documented truncation order.
      const channel = await hearthRepository.createChannel(USER, 'agents');
      const channelId = channel._id.toString();
      const now = new Date('2026-07-29T01:00:00Z');

      for (let i = 0; i < MAX_ROSTER_ROWS; i++) {
        const actor = await hearthRepository.ensureActor(USER, 'agent', `fresh-${i}`);
        await hearthRepository.upsertPresence(
          presence(channelId, actor._id.toString(), new Date('2026-07-29T00:59:00Z'), 'turn_finished')
        );
      }
      const stale = await hearthRepository.ensureActor(USER, 'agent', 'stale-blocked');
      await hearthRepository.upsertPresence(
        presence(channelId, stale._id.toString(), new Date('2026-07-29T00:40:00Z'), 'permission_prompt')
      );

      const roster = await hearthRepository.presenceForChannel(USER, channelId, { now });

      expect(roster).toHaveLength(MAX_ROSTER_ROWS);
      expect(roster.map(r => r.actorId.toString())).not.toContain(stale._id.toString());
      expect(roster.every(r => r.state === 'idle')).toBe(true);
    }, 60000);

    it('clamps a caller-supplied limit to the ceiling', async () => {
      const { channelId, actorId } = await setup();
      await hearthRepository.upsertPresence(presence(channelId, actorId, new Date(), 'tool_use'));

      expect(await hearthRepository.presenceForChannel(USER, channelId, { limit: 10_000 })).toHaveLength(1);
      // Mongo rejects a non-positive $limit, so these must not reach it verbatim.
      expect(await hearthRepository.presenceForChannel(USER, channelId, { limit: 0 })).toHaveLength(1);
      expect(await hearthRepository.presenceForChannel(USER, channelId, { limit: -5 })).toHaveLength(1);
    });
  });
});

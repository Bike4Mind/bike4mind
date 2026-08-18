import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { connectTestDB, disconnectTestDB, cleanupTestDB } from './utils';
import { CcAgentStatus } from '@bike4mind/common';
import { HearthPresence, presenceStateForReason, PRESENCE_STATE_RANK } from '../models/hearth/HearthPresenceModel';
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

  it('orders the roster needs-you-first, most recent within a state', async () => {
    const channel = await hearthRepository.createChannel(USER, 'general');
    const channelId = channel._id.toString();

    const actors = await Promise.all(
      ['idle-old', 'working-one', 'blocked-old', 'blocked-new'].map(name =>
        hearthRepository.ensureActor(USER, 'agent', name)
      )
    );
    const [idleOld, workingOne, blockedOld, blockedNew] = actors.map(a => a._id.toString());

    await hearthRepository.upsertPresence(
      presence(channelId, idleOld, new Date('2026-07-27T10:00:30Z'), 'turn_finished')
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

    const roster = await hearthRepository.presenceForChannel(USER, channelId);
    // Both blocked actors outrank the more recently seen running and idle rows,
    // AND the permission block outranks the question despite being seen EARLIER -
    // state ranking dominates recency, because a halted session is the thing
    // most in need of the human.
    expect(roster.map(r => r.actorId.toString())).toEqual([blockedOld, blockedNew, workingOne, idleOld]);
    expect(roster.map(r => r.state)).toEqual(['awaiting_permission', 'awaiting_input', 'running', 'idle']);
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
    it('caps returned rows and keeps the most urgent ones', async () => {
      const channel = await hearthRepository.createChannel(USER, 'agents');
      const channelId = channel._id.toString();

      // One more than the cap, all idle except a single blocked actor created LAST
      // (so insertion order cannot be what puts it first).
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

      const roster = await hearthRepository.presenceForChannel(USER, channelId);

      expect(roster).toHaveLength(MAX_ROSTER_ROWS);
      // Ranking happens BEFORE the limit, so truncation drops the least urgent
      // rows rather than whichever the scan reached last.
      expect(roster[0].actorId.toString()).toBe(blocked._id.toString());
      expect(roster[0].state).toBe('awaiting_permission');
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

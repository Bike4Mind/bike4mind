import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { connectTestDB, disconnectTestDB, cleanupTestDB } from './utils';
import { CcAgentStatus } from '@bike4mind/common';
import { HearthPresence, presenceStateForReason, PRESENCE_STATE_RANK } from '../models/hearth/HearthPresenceModel';
import { hearthRepository } from '../models/hearth/MongoHearthStore';

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
});

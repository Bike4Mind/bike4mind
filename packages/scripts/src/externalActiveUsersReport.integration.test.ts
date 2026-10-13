import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Quest, UsageEvent, User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

import { runExternalActivityReport } from './externalActiveUsersReport';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const agentExecutions = () => mongoose.model('AgentExecution').collection;

beforeEach(async () => {
  await User.collection.deleteMany({});
  await UsageEvent.collection.deleteMany({});
  await Quest.collection.deleteMany({});
  await agentExecutions().deleteMany({});
});

const NOW = new Date('2026-10-13T12:00:00Z');
const TEST_PATTERN = /\+(e2e|test)/i;
const STAFF_DOMAINS = 'staff.example.com';
const silent = () => undefined;
const at = (iso: string) => new Date(`${iso}T10:00:00Z`);

// Raw inserts skip the schema timestamps, so createdAt is seeded. Defaults to inside the window.
const insertUser = async (email: string, extra: Record<string, unknown> = {}) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id, username: `u-${_id}`, email, createdAt: at('2026-10-10'), ...extra });
  return String(_id);
};

const usage = (userId: string, iso: string, extra: Record<string, unknown> = {}) =>
  UsageEvent.collection.insertOne({ userId, createdAt: at(iso), status: 'ok', ...extra });

/** A fresh unique ObjectId whose creation time is `date`, as for a quest created when it was sent. */
const idAt = (date: Date) =>
  new mongoose.Types.ObjectId(
    Math.floor(date.getTime() / 1000)
      .toString(16)
      .padStart(8, '0') + new mongoose.Types.ObjectId().toHexString().slice(8)
  );

const quest = (userId: string, iso: string, extra: Record<string, unknown> = {}) =>
  Quest.collection.insertOne({
    _id: idAt(at(iso)),
    sessionId: 's1',
    type: 'message',
    timestamp: at(iso),
    promptMeta: { session: { id: 's1', userId } },
    ...extra,
  });

const agent = (userId: string, iso: string) => agentExecutions().insertOne({ userId, createdAt: at(iso) });

/**
 * Three external users, plus a staff, admin, test-pattern and unknown-user account active in
 * every source. Excluded users sit on the same days as the external ones so a leak would show.
 */
const seed = async () => {
  const alice = await insertUser('alice@customer.example');
  const bob = await insertUser('bob@customer.example');
  const carol = await insertUser('carol@customer.example');
  const staff = await insertUser('dev@staff.example.com');
  const admin = await insertUser('boss@customer.example', { isAdmin: true });
  const tester = await insertUser('qa+e2e@customer.example');
  const ghost = String(new mongoose.Types.ObjectId());

  // alice: two UsageEvents the same UTC day collapse to one active day, then a Quest the next day.
  await usage(alice, '2026-10-10', { source: 'chat' });
  await usage(alice, '2026-10-10', { source: 'chat' });
  await quest(alice, '2026-10-11');
  // Before the 90 day window (starts 2026-07-16): not read.
  await usage(alice, '2026-01-01', { source: 'chat' });

  // bob: AgentExecution on day one, a UsageEvent with no source the next, a failed call after that.
  await agent(bob, '2026-10-10');
  await usage(bob, '2026-10-11');
  await usage(bob, '2026-10-12', { status: 'error', source: 'chat' });

  // carol: one live Quest; the soft-deleted and non-message ones do not count.
  await quest(carol, '2026-10-10');
  await quest(carol, '2026-10-12', { deletedAt: new Date('2026-10-12T11:00:00Z') });
  await quest(carol, '2026-10-09', { type: 'voice' });

  for (const id of [staff, admin, tester, ghost, 'not-an-object-id']) {
    await usage(id, '2026-10-10', { source: 'api' });
    await usage(id, '2026-10-11', { source: 'api' });
    await quest(id, '2026-10-10');
    await agent(id, '2026-10-12');
  }
};

const run = (overrides: Partial<Parameters<typeof runExternalActivityReport>[0]> = {}) =>
  runExternalActivityReport({
    days: 90,
    testPattern: TEST_PATTERN,
    staffDomainsEnv: STAFF_DOMAINS,
    now: NOW,
    log: silent,
    ...overrides,
  });

describe('runExternalActivityReport', () => {
  it('counts only external users across all three sources and drops every excluded kind', async () => {
    await seed();

    const report = await run();

    expect(report.externalUsers).toBe(3);
    expect(report.excluded).toEqual({ noUser: 2, admin: 1, staffDomain: 1, testPattern: 1 });
    const dau = Object.fromEntries(report.dau.map(row => [row.day, row.users]));
    expect(report.dau).toHaveLength(30);
    expect(dau['2026-10-09']).toBe(0); // carol's voice quest is not a chat message
    expect(dau['2026-10-10']).toBe(3); // alice (usage x2), bob (agent), carol (quest)
    expect(dau['2026-10-11']).toBe(2); // alice (quest), bob (usage)
    expect(dau['2026-10-12']).toBe(0); // bob's error and carol's deleted quest do not count
    expect(dau['2026-10-13']).toBe(0);
  });

  it("reports UsageEvent rows by source for external users only, with 'unset' for a missing source", async () => {
    await seed();

    const report = await run();

    // alice 2 chat, bob 1 unset. bob's error row and every excluded user's 'api' rows are out.
    expect(report.sources).toEqual([
      { source: 'chat', rows: 2 },
      { source: 'unset', rows: 1 },
    ]);
  });

  it('buckets the three users into their signup week with D1 measured and D7 too young', async () => {
    await seed();

    const { cohorts } = await run();

    expect(cohorts.rows).toHaveLength(1);
    const [row] = cohorts.rows;
    expect(row.weekStart).toBe('2026-10-04');
    expect(row.signups).toBe(3);
    expect(row.activated).toBe(3);
    expect(row.retention[1]).toBeCloseTo(66.67, 1); // alice and bob return on 10-11, carol does not
    expect(row.retention[7]).toBeNull();
    expect(row.retention[30]).toBeNull();
  });

  it('reads only the requested window and leaves signups before it out of every cohort', async () => {
    await seed();

    // Window 2026-10-11..2026-10-13: alice and bob are active on the window start but signed up 10-10.
    const report = await run({ days: 3 });

    expect(report.externalUsers).toBe(2);
    expect(report.dau.map(row => row.users)).toEqual([2, 0, 0]);
    expect(report.cohorts).toEqual({ rows: [] });
  });

  it('counts a pre-window signup toward DAU but in no cohort, and an idle in-window signup in signups only', async () => {
    const veteran = await insertUser('vet@customer.example', { createdAt: at('2026-01-05') });
    await insertUser('idle@customer.example', { createdAt: at('2026-10-05') });
    await insertUser('staff-idle@staff.example.com', { createdAt: at('2026-10-05') });
    await usage(veteran, '2026-10-10');

    const report = await run();

    expect(report.externalUsers).toBe(1);
    expect(report.dau.find(row => row.day === '2026-10-10')?.users).toBe(1);
    expect(report.cohorts.rows).toEqual([
      expect.objectContaining({
        weekStart: '2026-10-04',
        signups: 1,
        activated: 0,
        activatedPercent: 0,
        retention: { 1: 0, 7: null, 30: null },
      }),
    ]);
  });

  it('applies a custom --test-pattern', async () => {
    await seed();

    const report = await run({ testPattern: /^alice@/i });

    // alice is out; the pattern replaces the default, so the qa+e2e account is external again.
    expect(report.externalUsers).toBe(3);
    expect(report.excluded.testPattern).toBe(1);
  });

  it('applies no staff exclusion and says so when no staff domains are configured', async () => {
    await seed();
    const lines: string[] = [];

    const report = await run({ staffDomainsEnv: '', log: message => lines.push(message) });

    expect(report.staffExclusionConfigured).toBe(false);
    expect(report.externalUsers).toBe(4); // the staff account now counts as external
    expect(lines.join('\n')).toContain('WARNING: NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS is empty');
  });

  it('does not credit the copier of a cloned quest on the source timestamp day', async () => {
    const dave = await insertUser('dave@customer.example');
    const erin = await insertUser('erin@customer.example');
    await quest(dave, '2026-10-10');
    // A session clone keeps the source timestamp (30 days back) but gets an _id created now.
    await quest(dave, '2026-09-13', { _id: idAt(NOW) });
    await quest(erin, '2026-09-13', { _id: idAt(NOW) });

    const report = await run();

    expect(report.externalUsers).toBe(1); // erin only has the copy
    // Both signed up 10-10 (default); only dave is activated, erin's only quest is a copy.
    expect(report.cohorts.rows).toEqual([
      expect.objectContaining({ weekStart: '2026-10-04', signups: 2, activated: 1 }),
    ]);
    expect(report.dau.reduce((sum, row) => sum + row.users, 0)).toBe(1);
  });

  it('prints one plain-text report to the log', async () => {
    await seed();
    const lines: string[] = [];

    await run({ log: message => lines.push(message) });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('DAU (UTC, last 30 days)');
    expect(lines[0]).toContain('UsageEvent rows by source');
    expect(lines[0]).toContain('Weekly signup cohorts');
    expect(lines[0]).not.toContain('@');
  });
});

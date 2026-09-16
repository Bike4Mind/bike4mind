import { inspect } from 'node:util';
import mongoose from 'mongoose';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { authFailLogRepository, type IAuthFailLogDocument } from './AuthFailLogModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

// Same instance the repository holds, so spying here observes the repository's own queries.
const AuthFailLog = mongoose.model<IAuthFailLogDocument>('AuthFailLog');

const FIVE_MINUTES_MS = 5 * 60 * 1000;

const CALLER = { username: 'victim', email: 'victim@example.com', ip: '198.51.100.7' };
const UNRELATED = { username: 'unrelated-user', email: 'unrelated@example.com', ip: '203.0.113.42' };

const since = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

/**
 * Raw insert so createdAt is deterministic (mongoose timestamps would stamp now). Every row is
 * anchored inside one 5-minute bucket an hour ago, so the co-occurrence grouping does not depend
 * on when the suite happens to run.
 */
const seedFailures = () => {
  const bucket = Math.floor((Date.now() - 60 * 60 * 1000) / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  const at = (offsetSeconds: number) => new Date(bucket + offsetSeconds * 1000);

  return AuthFailLog.collection.insertMany([
    { ip: CALLER.ip, username: CALLER.username, email: CALLER.email, createdAt: at(10), updatedAt: at(10) },
    {
      ip: CALLER.ip,
      username: 'neighbor-one',
      email: 'neighbor-one@example.com',
      createdAt: at(20),
      updatedAt: at(20),
    },
    {
      ip: CALLER.ip,
      username: 'neighbor-two',
      email: 'neighbor-two@example.com',
      createdAt: at(30),
      updatedAt: at(30),
    },
    { ip: UNRELATED.ip, username: UNRELATED.username, email: UNRELATED.email, createdAt: at(40), updatedAt: at(40) },
  ]);
};

const spyOnConsole = () =>
  (['log', 'info', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}));

const loggedText = (spies: ReturnType<typeof spyOnConsole>) =>
  spies
    .flatMap(spy => spy.mock.calls)
    .flat()
    .map(arg => (typeof arg === 'string' ? arg : inspect(arg, { depth: null })))
    .join('\n');

describe('AuthFailLogRepository.getSuspiciousPatternsTargetingUser', () => {
  beforeEach(seedFailures);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs no identifier belonging to an unrelated user', async () => {
    const spies = spyOnConsole();

    await authFailLogRepository.getSuspiciousPatternsTargetingUser(CALLER.username, since());

    const text = loggedText(spies);
    expect(text).not.toContain(UNRELATED.username);
    expect(text).not.toContain(UNRELATED.email);
    expect(text).not.toContain(UNRELATED.ip);
  });

  it('runs a single aggregation, with no unconsumed platform-wide scan', async () => {
    const aggregate = vi.spyOn(AuthFailLog, 'aggregate');

    await authFailLogRepository.getSuspiciousPatternsTargetingUser(CALLER.username, since());

    expect(aggregate).toHaveBeenCalledTimes(1);
  });

  it('still returns the IP co-occurrence pattern that targeted the caller', async () => {
    const patterns = await authFailLogRepository.getSuspiciousPatternsTargetingUser(CALLER.username, since());

    // Co-occurrence detection is the point of this query: the pattern only clears the
    // usernameCount >= 3 threshold because the caller was targeted alongside others from one IP.
    expect(patterns).toHaveLength(1);
    expect(patterns[0].ip).toBe(CALLER.ip);
    expect(patterns[0].usernames).toContain(CALLER.username);
    expect(patterns[0].attempts).toBe(3);
  });
});

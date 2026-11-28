import { describe, it, expect, beforeEach } from 'vitest';
import { getOAuthClientUsageStats, signInsMatch, signupsMatch } from './oauthClientUsageStats';
import { OAuthClientModel } from './OAuthClientModel';
import { OAuthClientSignInModel } from './OAuthClientSignInModel';
import { User } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const NOW = new Date('2026-11-27T12:00:00Z');
const daysAgo = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000 + extraMs);

const CLIENT_A = 'b4m_alpha_11111111';
const CLIENT_B = 'b4m_beta_22222222';
const CLIENT_C = 'b4m_gamma_33333333';

let seq = 0;
const addUser = (signupClientId: string | null, createdAt: Date) => {
  seq += 1;
  // Raw insert: bypasses timestamps so createdAt is exactly what the test sets.
  return User.collection.insertOne({
    username: `u${seq}`,
    email: `u${seq}@example.test`,
    signupClientId,
    createdAt,
    updatedAt: createdAt,
  });
};
const addSignIn = (clientId: string, lastSignInAt: Date) => {
  seq += 1;
  return OAuthClientSignInModel.create({
    userId: `user-${seq}`,
    clientId,
    firstSignInAt: daysAgo(90),
    lastSignInAt,
  });
};

beforeEach(async () => {
  await User.createIndexes();
  await OAuthClientSignInModel.createIndexes();
  for (const [clientId, name] of [
    [CLIENT_A, 'Alpha'],
    [CLIENT_B, 'Beta'],
    [CLIENT_C, 'Gamma'],
  ]) {
    await OAuthClientModel.create({
      clientId,
      clientSecretHash: 'hash',
      name,
      redirectUris: ['https://app.example/cb'],
    } as never);
  }
});

describe('getOAuthClientUsageStats', () => {
  it('counts sign-ups in the 7 and 30 day windows with inclusive lower bounds', async () => {
    await addUser(CLIENT_A, daysAgo(1));
    await addUser(CLIENT_A, daysAgo(7));
    await addUser(CLIENT_A, daysAgo(7, -1));
    await addUser(CLIENT_A, daysAgo(30));
    await addUser(CLIENT_A, daysAgo(30, -1));

    const stats = await getOAuthClientUsageStats(NOW);
    expect(stats[CLIENT_A]).toMatchObject({ signups7d: 2, signups30d: 4 });
  });

  it('counts active users by last sign-in in the same windows', async () => {
    await addSignIn(CLIENT_A, daysAgo(2));
    await addSignIn(CLIENT_A, daysAgo(7));
    await addSignIn(CLIENT_A, daysAgo(7, -1));
    await addSignIn(CLIENT_A, daysAgo(30));
    await addSignIn(CLIENT_A, daysAgo(30, -1));

    const stats = await getOAuthClientUsageStats(NOW);
    expect(stats[CLIENT_A]).toMatchObject({ activeUsers7d: 2, activeUsers30d: 4 });
  });

  it('keeps clients apart and ignores users with no signup client', async () => {
    await addUser(CLIENT_A, daysAgo(1));
    await addUser(CLIENT_B, daysAgo(1));
    await addUser(CLIENT_B, daysAgo(2));
    await addUser(null, daysAgo(1));
    await addSignIn(CLIENT_B, daysAgo(1));

    const stats = await getOAuthClientUsageStats(NOW);
    expect(stats[CLIENT_A]).toEqual({ signups7d: 1, signups30d: 1, activeUsers7d: 0, activeUsers30d: 0 });
    expect(stats[CLIENT_B]).toEqual({ signups7d: 2, signups30d: 2, activeUsers7d: 1, activeUsers30d: 1 });
  });

  it('returns zeros for a client with no rows and omits unregistered clients', async () => {
    await addUser('b4m_unregistered_deadbeef', daysAgo(1));
    await addSignIn('b4m_unregistered_deadbeef', daysAgo(1));

    const stats = await getOAuthClientUsageStats(NOW);
    expect(stats[CLIENT_C]).toEqual({ signups7d: 0, signups30d: 0, activeUsers7d: 0, activeUsers30d: 0 });
    expect(stats).not.toHaveProperty('b4m_unregistered_deadbeef');
  });

  describe('index use', () => {
    const planStages = (plan: unknown): string[] => {
      const stages: string[] = [];
      const walk = (node: unknown) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === 'object') {
          const obj = node as Record<string, unknown>;
          if (typeof obj.stage === 'string') stages.push(obj.stage);
          if (typeof obj.indexName === 'string') stages.push(`index:${obj.indexName}`);
          Object.values(obj).forEach(walk);
        }
      };
      walk(plan);
      return stages;
    };

    // Aggregate explain nests the plan differently by server version; collect every winningPlan, skip rejectedPlans.
    const winningPlans = (explain: unknown): unknown[] => {
      const found: unknown[] = [];
      const walk = (node: unknown) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === 'object') {
          for (const [key, value] of Object.entries(node)) {
            if (key === 'winningPlan') found.push(value);
            else if (key !== 'rejectedPlans') walk(value);
          }
        }
      };
      walk(explain);
      return found;
    };

    it('serves the sign-up count from user_signupClientId_createdAt without a collection scan', async () => {
      await addUser(CLIENT_A, daysAgo(1));
      const plan = await User.aggregate([signupsMatch([CLIENT_A], daysAgo(30))]).explain('queryPlanner');
      const stages = planStages(winningPlans(plan));
      expect(stages).toContain('IXSCAN');
      expect(stages).toContain('index:user_signupClientId_createdAt');
      expect(stages).not.toContain('COLLSCAN');
    });

    it('serves the active-user count from the clientId and lastSignInAt index', async () => {
      await addSignIn(CLIENT_A, daysAgo(1));
      const plan = await OAuthClientSignInModel.aggregate([signInsMatch([CLIENT_A], daysAgo(30))]).explain(
        'queryPlanner'
      );
      const stages = planStages(winningPlans(plan));
      expect(stages).toContain('IXSCAN');
      expect(stages).toContain('index:clientId_1_lastSignInAt_-1');
      expect(stages).not.toContain('COLLSCAN');
    });
  });
});

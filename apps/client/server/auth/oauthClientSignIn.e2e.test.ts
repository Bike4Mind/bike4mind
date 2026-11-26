// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  AuthEventModel,
  OAuthClientModel,
  OAuthClientSignInModel,
  User,
  oauthClientSignInRepository,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { createUniqueOAuthUser } from '../utils/auth/createOAuthUser';

// The route is baseApi().post(handler); unwrap it so the handler runs without the auth stack.
vi.mock('@server/middlewares/baseApi', () => {
  type Chain = { use: () => Chain; post: (fn: unknown) => unknown };
  const chain: Chain = { use: () => chain, post: fn => fn };
  return { baseApi: () => chain };
});
vi.mock('@server/analytics/oauthSignupCredit', () => ({ creditOAuthSignup: vi.fn(async () => []) }));
vi.mock('@bike4mind/server-utils/auth/riskEvidence', () => ({
  requestRiskEvidenceRefresh: vi.fn(async () => 'queued'),
}));
vi.mock('./signupNetworkAlerts', () => ({ alertSignupNetworkBurst: vi.fn(async () => undefined) }));

import handler from '../../pages/api/oauth/code';
import { recordSignupNetwork, type NetworkRequest } from './networkMeta';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await Promise.all([OAuthClientSignInModel.createIndexes(), User.createIndexes()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    AuthEventModel.deleteMany({}),
    OAuthClientModel.deleteMany({}),
    OAuthClientSignInModel.deleteMany({}),
  ]);
});

const CLIENT_A = 'b4m_client_a_0123abcd';
const CLIENT_B = 'b4m_client_b_0123abcd';
const REDIRECT = 'https://example.com/callback';
const T1 = new Date('2026-01-01T00:00:00Z');
const T2 = new Date('2026-02-01T00:00:00Z');
const REQ: NetworkRequest = { headers: { 'user-agent': 'Mozilla/5.0' }, socket: {} };

const seedUser = (name: string, signupClientId: string | null) =>
  createUniqueOAuthUser({
    name,
    baseUsername: name,
    email: `${name}@example.com`,
    oauthCredentials: { strategy: 'google', id: `sub-${name}` },
    signupClientId,
  });

const seedClient = (clientId: string) =>
  OAuthClientModel.create({
    clientId,
    clientSecretHash: 'unused',
    name: clientId,
    redirectUris: [REDIRECT],
    isActive: true,
    tokenEndpointAuthMethod: 'none',
  });

const signupClientIdOf = async (id: unknown) => (await User.findById(id).lean())?.signupClientId;

describe('recordSignupNetwork clientId against a real database', () => {
  it('stamps the signup event with the user signupClientId and leaves the user untouched', async () => {
    const user = await seedUser('with-client', CLIENT_A);

    await recordSignupNetwork({ req: REQ, userId: String(user._id), method: 'google', clientId: user.signupClientId });

    const events = await AuthEventModel.find({ userId: String(user._id), type: 'signup' }).lean();
    expect(events).toHaveLength(1);
    expect(events[0].clientId).toBe(CLIENT_A);
    expect(await signupClientIdOf(user._id)).toBe(CLIENT_A);
  });

  it('writes no clientId field for a user who did not sign up through an authorize flow', async () => {
    const user = await seedUser('no-client', null);

    await recordSignupNetwork({ req: REQ, userId: String(user._id), method: 'google', clientId: user.signupClientId });

    const events = await AuthEventModel.find({ userId: String(user._id), type: 'signup' }).lean();
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('clientId');
    expect(await signupClientIdOf(user._id)).toBeFalsy();
  });
});

describe('oauthClientSignInRepository.recordSignIn against a real database', () => {
  it('keeps one row per (user, client): first sign-in sets the record, later ones only move lastSignInAt', async () => {
    const user = await seedUser('repeat', CLIENT_A);
    const userId = String(user._id);

    await oauthClientSignInRepository.recordSignIn({ userId, clientId: CLIENT_A, at: T1 });
    await oauthClientSignInRepository.recordSignIn({ userId, clientId: CLIENT_A, at: T2 });

    const rows = await oauthClientSignInRepository.listByUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].firstSignInAt).toEqual(T1);
    expect(rows[0].lastSignInAt).toEqual(T2);
    expect(await signupClientIdOf(user._id)).toBe(CLIENT_A);
  });

  it('gives a second client its own row without touching signupClientId', async () => {
    const user = await seedUser('two-clients', CLIENT_A);
    const userId = String(user._id);

    await oauthClientSignInRepository.recordSignIn({ userId, clientId: CLIENT_A, at: T1 });
    await oauthClientSignInRepository.recordSignIn({ userId, clientId: CLIENT_B, at: T2 });

    const rows = await oauthClientSignInRepository.listByUser(userId);
    expect(rows.map(r => r.clientId)).toEqual([CLIENT_B, CLIENT_A]);
    expect(await signupClientIdOf(user._id)).toBe(CLIENT_A);
  });
});

describe('POST /api/oauth/code against a real database', () => {
  const issueCode = async (userId: string) => {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const req = {
      body: {
        client_id: CLIENT_A,
        redirect_uri: REDIRECT,
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
      },
      user: { id: userId },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    };
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, { status, json });
    return { status, json, req };
  };

  it('records the sign-in on the stored client id and only moves lastSignInAt on the second code', async () => {
    await seedClient(CLIENT_A);
    const user = await seedUser('handler-user', CLIENT_A);
    const userId = String(user._id);

    const first = await issueCode(userId);
    expect(first.json).toHaveBeenCalledWith(expect.objectContaining({ code: expect.any(String) }));
    const [afterFirst] = await oauthClientSignInRepository.listByUser(userId);
    expect(afterFirst.clientId).toBe(CLIENT_A);

    await issueCode(userId);

    const rows = await oauthClientSignInRepository.listByUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].firstSignInAt).toEqual(afterFirst.firstSignInAt);
    expect(rows[0].lastSignInAt.getTime()).toBeGreaterThanOrEqual(afterFirst.lastSignInAt.getTime());
    expect(await signupClientIdOf(user._id)).toBe(CLIENT_A);
  });
});

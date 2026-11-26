// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { createMocks } from 'node-mocks-http';
import {
  AuthEventModel,
  OAuthClientModel,
  OAuthClientSignInModel,
  OAuthAuthorizationCodeModel,
  OAuthGrantModel,
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
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => {} }));
vi.mock('./tokenGenerator', () => ({
  ACCESS_TOKEN_TTL_SECONDS: 1800,
  authTokenGenerator: { signAccessToken: vi.fn(() => 'access.jwt') },
}));
vi.mock('./oauthServer', async importOriginal => ({
  ...(await importOriginal<typeof import('./oauthServer')>()),
  generateIdToken: vi.fn(async () => 'id.jwt'),
}));

import { ForbiddenError } from '@bike4mind/common';
import handler from '../../pages/api/oauth/token';
import { generateAuthCode } from './oauthServer';
import { withAccountNotPurging } from './withAccountNotPurging';
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
    OAuthAuthorizationCodeModel.deleteMany({}),
    OAuthGrantModel.deleteMany({}),
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

const seedClient = (clientId: string, clientType?: 'relying-party') =>
  OAuthClientModel.create({
    ...(clientType ? { clientType } : {}),
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
    expect(rows[0].lastSignInAt.getTime()).toBeGreaterThan(rows[0].firstSignInAt.getTime());
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

describe('recordSignIn inside the purge guard against a real replica set', () => {
  it('survives two concurrent first sign-ins for the same (user, client)', async () => {
    const user = await seedUser('concurrent', CLIENT_A);
    const userId = String(user._id);

    await Promise.all([
      withAccountNotPurging(userId, () =>
        oauthClientSignInRepository.recordSignIn({ userId, clientId: CLIENT_A, at: T2 })
      ),
      withAccountNotPurging(userId, () =>
        oauthClientSignInRepository.recordSignIn({ userId, clientId: CLIENT_A, at: T1 })
      ),
    ]);

    const rows = await OAuthClientSignInModel.find({ userId, clientId: CLIENT_A }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].firstSignInAt).toEqual(T1);
    expect(rows[0].lastSignInAt).toEqual(T2);
  });

  it('refuses a purge-claimed user and writes no row', async () => {
    const user = await seedUser('purging', CLIENT_A);
    const userId = String(user._id);
    await User.updateOne({ _id: userId }, { $set: { 'deletion.purgeStartedAt': new Date() } });

    await expect(
      withAccountNotPurging(userId, () =>
        oauthClientSignInRepository.recordSignIn({ userId, clientId: CLIENT_A, at: T1 })
      )
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(await OAuthClientSignInModel.countDocuments({ userId })).toBe(0);
  });
});

describe('POST /api/oauth/token redemption against a real database', () => {
  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url');

  beforeAll(() => {
    vi.stubEnv('APP_URL', 'https://app.example.com');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  const redeem = async (code: string) => {
    const { req, res } = createMocks({
      method: 'POST',
      body: {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_A,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      },
    });
    (req as unknown as { logger: unknown }).logger = {
      log: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    return res;
  };
  const issueCode = (userId: string) =>
    generateAuthCode({
      clientId: CLIENT_A,
      userId,
      redirectUri: REDIRECT,
      scopes: ['openid'],
      codeChallenge: CHALLENGE,
    });

  it('records nothing when a code is issued, then records on redemption and only moves lastSignInAt on the next', async () => {
    await seedClient(CLIENT_A);
    const user = await seedUser('redeemer', CLIENT_A);
    const userId = String(user._id);

    const code = await issueCode(userId);
    expect(await OAuthClientSignInModel.countDocuments({ userId })).toBe(0);

    const first = await redeem(code);
    expect(first._getStatusCode()).toBe(200);
    const [afterFirst] = await oauthClientSignInRepository.listByUser(userId);
    expect(afterFirst.clientId).toBe(CLIENT_A);

    await new Promise(resolve => setTimeout(resolve, 5));
    expect((await redeem(await issueCode(userId)))._getStatusCode()).toBe(200);

    const rows = await oauthClientSignInRepository.listByUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].firstSignInAt).toEqual(afterFirst.firstSignInAt);
    expect(rows[0].lastSignInAt.getTime()).toBeGreaterThan(afterFirst.lastSignInAt.getTime());
  });

  it('records nothing for a failed redemption', async () => {
    await seedClient(CLIENT_A);
    const user = await seedUser('bad-redeemer', CLIENT_A);

    const res = await redeem('not-a-real-code');

    expect(res._getStatusCode()).toBe(400);
    expect(await OAuthClientSignInModel.countDocuments({ userId: String(user._id) })).toBe(0);
  });

  it('records a relying-party redemption', async () => {
    await seedClient(CLIENT_A, 'relying-party');
    const user = await seedUser('rp-redeemer', CLIENT_A);
    const userId = String(user._id);
    await OAuthGrantModel.create({ userId, clientId: CLIENT_A, scopes: ['openid'] });

    const res = await redeem(await issueCode(userId));

    expect(res._getStatusCode()).toBe(200);
    const rows = await oauthClientSignInRepository.listByUser(userId);
    expect(rows.map(r => r.clientId)).toEqual([CLIENT_A]);
  });

  it('writes no row and issues no session for a purge-claimed user on a first-party redemption', async () => {
    await seedClient(CLIENT_A);
    const user = await seedUser('purge-redeemer', CLIENT_A);
    const userId = String(user._id);
    const code = await issueCode(userId);
    await User.updateOne({ _id: userId }, { $set: { 'deletion.purgeStartedAt': new Date() } });

    await expect(redeem(code)).rejects.toBeInstanceOf(ForbiddenError);

    expect(await OAuthClientSignInModel.countDocuments({ userId })).toBe(0);
  });
});

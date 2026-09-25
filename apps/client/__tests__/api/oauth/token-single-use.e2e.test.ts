// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import crypto from 'crypto';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { OAuthAuthorizationCodeModel, User } from '@bike4mind/database';

/**
 * Pins the ordering in pages/api/oauth/token.ts: the code is READ (findValidCode) and validated
 * against client_id/redirect_uri/PKCE BEFORE it is atomically consumed (consumeValidCode). So a
 * redemption that fails those checks does NOT burn the code - the legitimate client can still redeem
 * it with corrected parameters. Single-use is preserved by the atomic consume, which runs only once
 * validation passes: a successfully redeemed code cannot be redeemed a second time.
 *
 * (This reverses the earlier consume-first / burn-on-mismatch behavior, per the review on
 * token.ts:64 - PKCE / client-secret already stop a mismatched party from COMPLETING the exchange,
 * so burning on mismatch added no real code-injection protection while denying honest retries and
 * handing anyone with a leaked code a way to invalidate the victim's login.)
 *
 * Drives the real repository/model against createMongoServer, since a mocked consumeValidCode could
 * not show the stored row's `used` flag actually staying false on a mismatch and flipping on success.
 */

// The route builds itself as baseApi().use(rateLimit).post(handler); unwrap it to the bare
// handler so the test drives the OAuth logic without the auth/rate-limit middleware stack.
vi.mock('@server/middlewares/baseApi', () => {
  type Chain = { use: () => Chain; post: (fn: unknown) => unknown };
  const chain: Chain = { use: () => chain, post: fn => fn };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => {} }));

vi.mock('@server/auth/issueSession', () => ({
  issueSessionForRequest: vi.fn().mockResolvedValue({
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    sid: 'fake-sid',
  }),
}));

// verifyPkce stays real so the S256 pair below is genuinely checked. validateClient must
// return a valid client even for the mismatched client_id/redirect_uri in the tests below -
// otherwise the handler 401s before reaching consumeValidCode and proves nothing.
vi.mock('@server/auth/oauthServer', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/auth/oauthServer')>();
  return {
    ...actual,
    validateClient: vi.fn().mockResolvedValue({ clientId: 'stub-client', redirectUris: [], isActive: true }),
    validateClientSecret: vi.fn().mockResolvedValue(null),
    generateIdToken: vi.fn().mockReturnValue('fake-id-token'),
  };
});

import handler from '../../../pages/api/oauth/token';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const VERIFIER = crypto.randomBytes(32).toString('base64url');
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url');

const CLIENT_A = { clientId: 'client-a', redirectUri: 'https://a.example.com/callback' };
const CLIENT_B_ID = 'client-b';

const seedCode = async (userId: string) => {
  // Same width as generateAuthCode() in server/auth/oauthServer.ts.
  const code = crypto.randomBytes(32).toString('base64url');
  await OAuthAuthorizationCodeModel.create({
    code,
    clientId: CLIENT_A.clientId,
    redirectUri: CLIENT_A.redirectUri,
    userId,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256',
    scopes: ['openid'],
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    used: false,
  });
  return code;
};

const redeem = async (params: { code: string; client_id: string; redirect_uri: string }) => {
  const { req, res } = createMocks({
    method: 'POST',
    body: {
      grant_type: 'authorization_code',
      code: params.code,
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      code_verifier: VERIFIER,
    },
  });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

describe('POST /api/oauth/token validate-before-consume (real repository)', () => {
  it('does NOT burn the code on a client_id mismatch; the corrected retry then succeeds', async () => {
    const user = await User.create({
      username: 'oauth-user-1',
      name: 'OAuth User 1',
      email: 'oauth-user-1@example.com',
    });
    const code = await seedCode(String(user._id));

    const mismatched = await redeem({ code, client_id: CLIENT_B_ID, redirect_uri: CLIENT_A.redirectUri });
    expect(mismatched._getStatusCode()).toBe(400);
    expect(mismatched._getJSONData()).toMatchObject({
      error: 'invalid_grant',
      error_description: 'client_id or redirect_uri mismatch',
    });

    // Same code, now with the CORRECT client params. The mismatch above only READ the code, so it is
    // still live and the honest client completes the exchange.
    const retry = await redeem({ code, client_id: CLIENT_A.clientId, redirect_uri: CLIENT_A.redirectUri });
    expect(retry._getStatusCode()).toBe(200);
  });

  it('does NOT burn the code on a redirect_uri mismatch; the corrected retry then succeeds', async () => {
    const user = await User.create({
      username: 'oauth-user-2',
      name: 'OAuth User 2',
      email: 'oauth-user-2@example.com',
    });
    const code = await seedCode(String(user._id));

    const otherRedirect = 'https://a.example.com/other-callback';
    const mismatched = await redeem({ code, client_id: CLIENT_A.clientId, redirect_uri: otherRedirect });
    expect(mismatched._getStatusCode()).toBe(400);
    expect(mismatched._getJSONData()).toMatchObject({
      error: 'invalid_grant',
      error_description: 'client_id or redirect_uri mismatch',
    });

    const retry = await redeem({ code, client_id: CLIENT_A.clientId, redirect_uri: CLIENT_A.redirectUri });
    expect(retry._getStatusCode()).toBe(200);
  });

  it('leaves the row unused in the database after a mismatch (read, not consumed)', async () => {
    const user = await User.create({
      username: 'oauth-user-3',
      name: 'OAuth User 3',
      email: 'oauth-user-3@example.com',
    });
    const code = await seedCode(String(user._id));

    await redeem({ code, client_id: CLIENT_B_ID, redirect_uri: CLIENT_A.redirectUri });

    // Re-read from the database rather than trusting the handler's own response.
    const row = await OAuthAuthorizationCodeModel.findOne({ code }).lean();
    expect(row?.used).toBe(false);
  });

  it('positive control: a fresh code with fully correct params reaches 200', async () => {
    const user = await User.create({
      username: 'oauth-user-4',
      name: 'OAuth User 4',
      email: 'oauth-user-4@example.com',
    });
    const code = await seedCode(String(user._id));

    const res = await redeem({ code, client_id: CLIENT_A.clientId, redirect_uri: CLIENT_A.redirectUri });
    expect(res._getStatusCode()).toBe(200);
  });

  it('is still single-use: a successfully redeemed code cannot be redeemed again', async () => {
    const user = await User.create({
      username: 'oauth-user-5',
      name: 'OAuth User 5',
      email: 'oauth-user-5@example.com',
    });
    const code = await seedCode(String(user._id));

    const first = await redeem({ code, client_id: CLIENT_A.clientId, redirect_uri: CLIENT_A.redirectUri });
    expect(first._getStatusCode()).toBe(200);

    // The atomic consume flipped used->true; a replay of the same code is rejected as spent.
    const replay = await redeem({ code, client_id: CLIENT_A.clientId, redirect_uri: CLIENT_A.redirectUri });
    expect(replay._getStatusCode()).toBe(400);
    expect(replay._getJSONData()).toMatchObject({
      error: 'invalid_grant',
      error_description: 'Invalid or expired authorization code',
    });

    const row = await OAuthAuthorizationCodeModel.findOne({ code }).lean();
    expect(row?.used).toBe(true);
  });
});

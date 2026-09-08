import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { chatContract } from '@bike4mind/common';

// The adapter connects to the DB and authenticates before validating; mock those
// so this stays a pure unit test of the adapter's parse/auth/validate/shape logic.
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  mongoose: { connection: { readyState: 1 } },
}));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://x/%STAGE%', STAGE: 'test' } }));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    updateMetadata() {}
    info() {}
    error() {}
  },
}));
const mockResolveAuth = vi.fn();
vi.mock('./resolveContractAuth', () => ({ resolveContractAuth: (...args: unknown[]) => mockResolveAuth(...args) }));

import { defineLambdaRoute } from './defineLambdaRoute';

const makeEvent = (body: unknown): APIGatewayProxyEventV2 =>
  ({ headers: { authorization: 'Bearer x' }, body: JSON.stringify(body) }) as unknown as APIGatewayProxyEventV2;
const asResult = (r: Awaited<ReturnType<ReturnType<typeof defineLambdaRoute>>>) =>
  r as APIGatewayProxyStructuredResultV2;

/**
 * Proves the SAME contract that drives the Next.js handler and the OpenAPI spec
 * also drives a Lambda Function URL handler - parse/auth/validate/shape all come
 * from the contract, not a hand-rolled per-transport copy.
 */
describe('defineLambdaRoute + chatContract', () => {
  const route = defineLambdaRoute(chatContract, async ({ validated, auth }) => ({
    statusCode: 200,
    // `validated` is typed as the contract's request body; `auth` is the resolved caller.
    body: { id: 'quest_1', status: 'queued', echoed: validated.message, user: auth?.userId },
  }));

  beforeEach(() => {
    mockResolveAuth.mockReset().mockResolvedValue({ method: 'jwt', userId: 'u1', user: {} });
  });

  it('authenticates, validates, and passes the typed body + caller through', async () => {
    const res = asResult(await route(makeEvent({ message: 'hello' })));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toMatchObject({ status: 'queued', echoed: 'hello', user: 'u1' });
  });

  it('rejects a body that fails contract validation with 422', async () => {
    const res = asResult(await route(makeEvent({ notMessage: 1 })));
    expect(res.statusCode).toBe(422);
  });

  it('rejects unparseable JSON with 400 (before auth)', async () => {
    const res = asResult(await route({ headers: {}, body: '{not json' } as unknown as APIGatewayProxyEventV2));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a failed authentication with 401 (before validation)', async () => {
    mockResolveAuth.mockRejectedValueOnce(new Error('No authorization token provided'));
    // Body is invalid too, but auth runs first, so the status is 401 (not 422).
    const res = asResult(await route(makeEvent({ notMessage: 1 })));
    expect(res.statusCode).toBe(401);
  });
});

/**
 * The adapter owns the auth -> rate limit -> validation ordering so both transports
 * meter identically regardless of where a handler happens to call the limiter.
 */
describe('defineLambdaRoute rate-limit ordering', () => {
  const rateLimit = vi.fn();
  const route = defineLambdaRoute(chatContract, async () => ({ statusCode: 200, body: { ok: true } }), {
    rateLimit: (ctx: unknown) => rateLimit(ctx),
  });

  beforeEach(() => {
    mockResolveAuth.mockReset().mockResolvedValue({ method: 'jwt', userId: 'u1', user: {} });
    rateLimit.mockReset().mockResolvedValue(undefined);
  });

  it('meters a malformed body BEFORE validation (429 beats 422)', async () => {
    rateLimit.mockRejectedValueOnce(new Error('Rate limit exceeded'));
    // Body is invalid too, but the limiter runs first, so the status is 429 (not 422).
    const res = asResult(await route(makeEvent({ notMessage: 1 })));
    expect(res.statusCode).toBe(429);
    expect(rateLimit).toHaveBeenCalledOnce();
  });

  it('runs the limiter after auth, with the resolved caller', async () => {
    await route(makeEvent({ message: 'hi' }));
    expect(rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ userId: 'u1' }) })
    );
  });

  it('does not meter when auth fails (401 short-circuits the limiter)', async () => {
    mockResolveAuth.mockRejectedValueOnce(new Error('nope'));
    const res = asResult(await route(makeEvent({ message: 'hi' })));
    expect(res.statusCode).toBe(401);
    expect(rateLimit).not.toHaveBeenCalled();
  });
});

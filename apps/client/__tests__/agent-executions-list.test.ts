/**
 * Handler-level tests for `GET /api/agent-executions`. Covers auth, the 400
 * cross-field guards, MAX_LIMIT enforcement, and the array-param normalization
 * that the existing repository tests don't exercise.
 *
 * baseApi is mocked as a passthrough so the route handler runs directly with
 * the mocked request - thrown HTTP errors propagate out, which we assert on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const findByUserIdPaginated = vi.hoisted(() => vi.fn());

vi.mock('@bike4mind/database', () => ({
  agentExecutionRepository: { findByUserIdPaginated },
  AGENT_EXECUTION_STATUSES: [
    'pending',
    'running',
    'continuing',
    'awaiting_permission',
    'awaiting_subagent',
    'paused',
    'completed',
    'failed',
    'aborted',
  ] as const,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    get: (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => fn(req, res),
  }),
}));

import handler from '../pages/api/agent-executions/index';
import { BadRequestError, UnauthorizedError } from '@server/utils/errors';

function makeReqRes(overrides: Partial<Request> = {}) {
  const req = {
    method: 'GET',
    query: {},
    headers: {},
    user: { id: 'user-1' },
    ...overrides,
  } as unknown as Request;
  const json = vi.fn();
  const res = {
    status: vi.fn().mockReturnThis(),
    json,
  } as unknown as Response;
  return { req, res, json };
}

describe('GET /api/agent-executions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByUserIdPaginated.mockResolvedValue({ items: [], nextCursor: null });
  });

  it('throws UnauthorizedError when req.user is absent', async () => {
    const { req, res } = makeReqRes({ user: undefined });
    await expect(handler(req, res)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(findByUserIdPaginated).not.toHaveBeenCalled();
  });

  it('rejects minCredits > maxCredits with 400', async () => {
    const { req, res } = makeReqRes({ query: { minCredits: '50', maxCredits: '10' } });
    await expect(handler(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(findByUserIdPaginated).not.toHaveBeenCalled();
  });

  it('rejects from > to with 400', async () => {
    const { req, res } = makeReqRes({
      query: { from: '2026-06-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' },
    });
    await expect(handler(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(findByUserIdPaginated).not.toHaveBeenCalled();
  });

  it('rejects limit above MAX_LIMIT (100) with 400', async () => {
    const { req, res } = makeReqRes({ query: { limit: '101' } });
    await expect(handler(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(findByUserIdPaginated).not.toHaveBeenCalled();
  });

  it('accepts limit at MAX_LIMIT (100)', async () => {
    const { req, res } = makeReqRes({ query: { limit: '100' } });
    await handler(req, res);
    expect(findByUserIdPaginated).toHaveBeenCalledWith(
      'user-1',
      expect.any(Object),
      expect.objectContaining({ limit: 100 })
    );
  });

  it('normalizes a repeated `status` array into the repo filter', async () => {
    const { req, res } = makeReqRes({ query: { status: ['completed', 'failed'] } });
    await handler(req, res);
    expect(findByUserIdPaginated).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ statuses: ['completed', 'failed'] }),
      expect.any(Object)
    );
  });

  it('normalizes a single-value `status` query param into a 1-element array', async () => {
    const { req, res } = makeReqRes({ query: { status: 'completed' } });
    await handler(req, res);
    expect(findByUserIdPaginated).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ statuses: ['completed'] }),
      expect.any(Object)
    );
  });

  it('normalizes single + array `model` params', async () => {
    const { req, res } = makeReqRes({ query: { model: 'gpt-5' } });
    await handler(req, res);
    expect(findByUserIdPaginated).toHaveBeenLastCalledWith(
      'user-1',
      expect.objectContaining({ models: ['gpt-5'] }),
      expect.any(Object)
    );

    const second = makeReqRes({ query: { model: ['gpt-5', 'claude-opus-4-7'] } });
    await handler(second.req, second.res);
    expect(findByUserIdPaginated).toHaveBeenLastCalledWith(
      'user-1',
      expect.objectContaining({ models: ['gpt-5', 'claude-opus-4-7'] }),
      expect.any(Object)
    );
  });

  it('rejects an unknown status value with 400', async () => {
    const { req, res } = makeReqRes({ query: { status: 'not-a-status' } });
    await expect(handler(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(findByUserIdPaginated).not.toHaveBeenCalled();
  });

  // Regression: axios serializes arrays with `arrayFormat: 'brackets'`
  // (`status[]=foo&status[]=bar`), and Next.js's pages-API query parser stores
  // the literal key `"status[]"` instead of expanding it. Without the
  // bracket-key normalization, the Zod schema looks up `status`, finds
  // undefined, and silently drops the filter - observed on the preview
  // env where selecting "Running" returned a `completed` row.
  it('normalizes `status[]` bracket-suffix keys into the bare key', async () => {
    const { req, res } = makeReqRes({ query: { 'status[]': ['running', 'continuing'] } });
    await handler(req, res);
    expect(findByUserIdPaginated).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ statuses: ['running', 'continuing'] }),
      expect.any(Object)
    );
  });

  it('normalizes `model[]` bracket-suffix keys into the bare key', async () => {
    const { req, res } = makeReqRes({ query: { 'model[]': 'claude-opus-4-7' } });
    await handler(req, res);
    expect(findByUserIdPaginated).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ models: ['claude-opus-4-7'] }),
      expect.any(Object)
    );
  });

  it('prefers the bracket-suffix key when both shapes are present', async () => {
    const { req, res } = makeReqRes({
      query: { status: 'completed', 'status[]': ['running', 'failed'] },
    });
    await handler(req, res);
    expect(findByUserIdPaginated).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ statuses: ['running', 'failed'] }),
      expect.any(Object)
    );
  });

  it('passes the opaque `before` cursor through to the repo', async () => {
    const cursor = '2026-06-01T12:00:00.000Z_507f1f77bcf86cd799439011';
    const { req, res } = makeReqRes({ query: { before: cursor } });
    await handler(req, res);
    expect(findByUserIdPaginated).toHaveBeenCalledWith(
      'user-1',
      expect.any(Object),
      expect.objectContaining({ before: cursor })
    );
  });

  it('returns the repo response unchanged', async () => {
    findByUserIdPaginated.mockResolvedValueOnce({
      items: [{ id: 'exec-1' }],
      nextCursor: 'cursor-1',
    });
    const { req, res, json } = makeReqRes();
    await handler(req, res);
    expect(json).toHaveBeenCalledWith({ items: [{ id: 'exec-1' }], nextCursor: 'cursor-1' });
  });
});

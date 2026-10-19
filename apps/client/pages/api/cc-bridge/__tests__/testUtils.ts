import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';

export type RouteHandler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

/** Build a mock request/response pair; `user` and `logger` mimic what baseApi attaches. */
export function mockRoute(opts: {
  body?: unknown;
  user?: Record<string, unknown> | null;
  headers?: Record<string, string>;
}) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method: 'POST',
    body: opts.body as Record<string, unknown>,
    headers: opts.headers,
  });
  const logger = { updateMetadata: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  Object.assign(req, { user: opts.user ?? undefined, logger });
  return { req, res };
}

export const tavernUser = { id: 'user-1', isAdmin: true, tags: [] as string[] };

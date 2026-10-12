import { NotFoundError } from '@bike4mind/common';
import errorHandler from '@server/middlewares/errorHandler';
import { logging } from '@server/middlewares/logging';
import { Request, Response } from 'express';
import nc from 'next-connect';

/**
 * Catch-all for /api/* paths no other route serves. Without it the request falls through to the
 * SPA's optional catch-all (app/[[...slug]]/page.tsx) and an API caller gets `200 text/html`.
 * Every real route is more specific than this one, so Next.js tries them first; the
 * next.config.mjs rewrites (/p, /a, /embed, /.well-known) are afterFiles rewrites, which Next.js
 * applies before dynamic routes, so they still reach their handlers. Two-segment misses never get
 * here: pages/api/[type]/[id] (the invite lookup) outranks this route and answers its own JSON 404.
 * Every /api/v1 miss goes to pages/api/v1/[...unmatchedV1Path] (same handler) instead.
 * server/__tests__/apiCatchAllRouting.test.ts checks the precedence against the real route files.
 *
 * No auth and no DB connect: there is nothing to authorize, and a 404 must not cost a Mongo
 * round-trip. The body is the shared error envelope (errorHandler).
 */
const handler = nc<Request, Response>({ onError: errorHandler })
  .use(logging)
  .all(() => {
    throw new NotFoundError('No API route matches this path');
  });

export default handler;

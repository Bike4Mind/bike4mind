import type { Request, Response } from 'express';
import errorHandler from '@server/middlewares/errorHandler';

type Step = (req: Request, res: Response, next: () => void) => unknown;

/** Options each route passed to baseApi, so a test can pin its scope gate (the stub skips it). */
export const baseApiOptions: unknown[] = [];

/**
 * Test stand-in for server/middlewares/baseApi.ts, used as
 * `vi.mock('@server/middlewares/baseApi', () => import('@server/qa/testing/baseApiStub'))`.
 * No DB connect and no auth chain, so requireQaIngestKey (ingest), ensureAdmin
 * (admin reads) or the report token is what enforces access in those tests.
 * A throw is served by the real errorHandler, so the status and body match production.
 */
export function baseApi(options: unknown = {}) {
  baseApiOptions.push(options);
  const compose =
    (...steps: Step[]) =>
    async (req: Request, res: Response) => {
      try {
        for (const step of steps) {
          let advanced = false;
          await step(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      } catch (err) {
        errorHandler(err, req, res);
      }
    };
  const chain: Record<string, unknown> = {};
  chain.use = () => chain;
  chain.get = compose;
  chain.post = compose;
  return chain;
}

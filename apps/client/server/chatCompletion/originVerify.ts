import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

// Must stay in sync with ORIGIN_VERIFY_HEADER in apps/client/proxy.ts and infra/router.ts.
const ORIGIN_VERIFY_HEADER = 'x-b4m-origin-verify';

// Same semantics as apps/client/proxy.ts: ORIGIN_VERIFY_SECRET is set only on deployed stages
// (infra/chatCompletion.ts), so self-host and local dev pass through. Read per request so the
// gate follows the environment.
export function requireOriginVerify(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.ORIGIN_VERIFY_SECRET;
  if (!secret) return next();

  const header = req.headers[ORIGIN_VERIFY_HEADER];
  const provided = Buffer.from(typeof header === 'string' ? header : '');
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    console.warn(`[SECURITY] Blocked direct-origin request: ${req.method} ${req.path}`);
    res.status(403).send('Forbidden');
    return;
  }

  delete req.headers[ORIGIN_VERIFY_HEADER];
  next();
}

import type { Request, Response } from 'express';
import { methodNotAllowedHandler } from '@server/middlewares/baseApi';

type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

// A contract router's declared request type carries its contract's validated fields, which exist
// only once its own prelude has run - so the table accepts any request shape and the call casts.
type MethodRouter = (req: never, res: Response) => unknown;

/**
 * Page handler for a path whose verbs are served by separate routers (nextRouteForContract refuses
 * any verb its contract does not declare, so a path with several contracts needs one router each).
 * Any verb missing from `routes` gets a 405 whose `Allow` lists every key, so the table is the single
 * source for both the dispatch and the header. GET also serves HEAD unless HEAD has its own entry.
 */
export function dispatchByMethod(routes: Partial<Record<HttpMethod, MethodRouter>>) {
  const routers = new Map<string, MethodRouter | undefined>(Object.entries(routes));
  const methodNotAllowed = methodNotAllowedHandler([...routers.keys()]);
  return (req: Request, res: Response) => {
    const method = req.method?.toUpperCase() ?? '';
    const router = routers.get(method) ?? (method === 'HEAD' ? routers.get('GET') : undefined);
    if (router) return router(req as never, res);
    return methodNotAllowed(req, res);
  };
}

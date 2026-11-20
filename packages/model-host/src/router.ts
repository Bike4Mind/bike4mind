import { MODEL_HOST_ROLES, type ModelHostRole } from '@bike4mind/common/modelHub';
import { HttpError, type RequestContext, type RequestHandler } from './server';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** `params` holds each `:name` segment of the route's path, percent-decoded. */
export interface RouteContext extends RequestContext {
  params: Record<string, string>;
}

export interface Route {
  method: Method;
  /** Segments starting with `:` match one non-empty path segment; a value containing `/` must be sent as `%2F`. */
  path: string;
  /** The lowest role that may call it. */
  role: ModelHostRole;
  handle: (ctx: RouteContext) => Promise<void> | void;
}

const rank = (role: ModelHostRole) => MODEL_HOST_ROLES.indexOf(role);

export function roleAllows(have: ModelHostRole, need: ModelHostRole): boolean {
  return rank(have) >= rank(need);
}

/** How much of a request path an error message echoes. */
export const MAX_ECHOED_PATH = 200;

const echoed = (path: string) => (path.length > MAX_ECHOED_PATH ? `${path.slice(0, MAX_ECHOED_PATH)}...` : path);

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (!want[i].startsWith(':')) {
      if (want[i] !== got[i]) return null;
      continue;
    }
    if (!got[i]) return null;
    try {
      params[want[i].slice(1)] = decodeURIComponent(got[i]);
    } catch {
      return null;
    }
  }
  return params;
}

export function createRouter(routes: readonly Route[]): RequestHandler {
  return async (ctx: RequestContext) => {
    const path = new URL(ctx.req.url ?? '/', 'http://b4m-host').pathname;
    const matches = routes.flatMap(route => {
      const params = matchPath(route.path, path);
      return params ? [{ route, params }] : [];
    });
    if (!matches.length) throw new HttpError(404, 'not-found', `No route ${echoed(path)}.`);
    const match = matches.find(candidate => candidate.route.method === ctx.req.method);
    if (!match) {
      throw new HttpError(405, 'method-not-allowed', `${echoed(path)} does not take ${echoed(ctx.req.method ?? '')}.`, {
        allow: [...new Set(matches.map(candidate => candidate.route.method))].join(', '),
      });
    }
    const { route, params } = match;
    if (!roleAllows(ctx.conn.role, route.role)) {
      throw new HttpError(
        403,
        'forbidden',
        `${echoed(path)} needs the ${route.role} role; this connection has ${ctx.conn.role}.`
      );
    }
    await route.handle({ ...ctx, params });
  };
}

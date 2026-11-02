import { MODEL_HOST_ROLES, type ModelHostRole } from '@bike4mind/common/modelHub';
import { HttpError, type RequestContext, type RequestHandler } from './server';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface Route {
  method: Method;
  path: string;
  /** The lowest role that may call it. */
  role: ModelHostRole;
  handle: RequestHandler;
}

const rank = (role: ModelHostRole) => MODEL_HOST_ROLES.indexOf(role);

export function roleAllows(have: ModelHostRole, need: ModelHostRole): boolean {
  return rank(have) >= rank(need);
}

/** How much of a request path an error message echoes. */
export const MAX_ECHOED_PATH = 200;

const echoed = (path: string) => (path.length > MAX_ECHOED_PATH ? `${path.slice(0, MAX_ECHOED_PATH)}...` : path);

export function createRouter(routes: readonly Route[]): RequestHandler {
  return async (ctx: RequestContext) => {
    const path = new URL(ctx.req.url ?? '/', 'http://b4m-host').pathname;
    const matches = routes.filter(route => route.path === path);
    if (!matches.length) throw new HttpError(404, 'not-found', `No route ${echoed(path)}.`);
    const route = matches.find(candidate => candidate.method === ctx.req.method);
    if (!route) {
      throw new HttpError(405, 'method-not-allowed', `${path} does not take ${echoed(ctx.req.method ?? '')}.`, {
        allow: matches.map(match => match.method).join(', '),
      });
    }
    if (!roleAllows(ctx.conn.role, route.role)) {
      throw new HttpError(
        403,
        'forbidden',
        `${path} needs the ${route.role} role; this connection has ${ctx.conn.role}.`
      );
    }
    await route.handle(ctx);
  };
}

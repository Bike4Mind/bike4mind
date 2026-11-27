/**
 * Test-only: a stand-in for nextRouteForContract that keeps the contract's own validation (path params,
 * query, body) and turns a thrown HTTPError into its status, so route tests exercise the handler body
 * without the auth and rate-limit stack. vi.mock factories reach it through a dynamic import.
 */
import { createMocks } from 'node-mocks-http';
import { HTTPError, type EndpointContract } from '@bike4mind/common';

type Res = { status(code: number): { json(body: unknown): unknown; end(): unknown } };
type Handler = (req: Record<string, unknown>, res: Res) => unknown;

export function nextRouteForContractMock() {
  return (contract: EndpointContract) => {
    const handlers: Record<string, Handler> = {};
    type Chain = typeof run & Record<'get' | 'post' | 'patch' | 'delete', (fn: Handler) => Chain>;
    const run = async (
      req: Record<string, unknown> & { method: string; query: Record<string, unknown>; body: unknown },
      res: Res
    ) => {
      try {
        const params = contract.pathParams;
        if (params) req.validatedParams = params.parse(req.query);
        if (contract.queryParams) req.validatedQuery = contract.queryParams.parse(req.query);
        if (contract.request) req.validated = contract.request.parse(req.body);
        return await handlers[req.method]?.(req, res);
      } catch (error) {
        if (!(error instanceof HTTPError)) throw error;
        return res.status(error.statusCode).json({ error: error.message, ...error.additionalInfo });
      }
    };
    const chain: Chain = Object.assign(run, {
      get: (fn: Handler) => ((handlers.GET = fn), chain),
      post: (fn: Handler) => ((handlers.POST = fn), chain),
      patch: (fn: Handler) => ((handlers.PATCH = fn), chain),
      delete: (fn: Handler) => ((handlers.DELETE = fn), chain),
    });
    return chain;
  };
}

export const dispatchByMethodMock =
  () => (routes: Record<string, (req: unknown, res: Res) => unknown>) => (req: { method: string }, res: Res) =>
    routes[req.method] ? routes[req.method](req, res) : res.status(405).end();

export const TEST_USER = { id: 'user-1', name: 'Ada', username: 'ada', isAdmin: false };

/** Runs a route handler with a mocked request as the test user; `query` carries path params and query string. */
export async function callRoute(
  handler: unknown,
  init: { method: string; query?: Record<string, string>; body?: Record<string, unknown> }
) {
  const { req, res } = createMocks({ method: init.method as 'GET', query: init.query, body: init.body });
  Object.assign(req, { user: TEST_USER, logger: { info: () => {}, warn: () => {} } });
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  const text = res._getData();
  return {
    status: res._getStatusCode() as number,
    headers: res._getHeaders() as Record<string, unknown>,
    text: typeof text === 'string' ? text : '',
    json: res._isJSON() ? (res._getJSONData() as { error?: string; data: Array<Record<string, unknown>> }) : undefined,
  };
}

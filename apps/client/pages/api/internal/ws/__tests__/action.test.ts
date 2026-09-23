import { describe, it, expect, vi, beforeEach } from 'vitest';

// The self-host WS bridge is wrapped in baseApi; collapse it to a bare handler so the
// credential-forwarding logic can be tested without the auth/DB middleware chain.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: vi.fn(() => ({
    post: vi.fn((handler: (req: unknown, res: unknown) => Promise<unknown>) => handler),
  })),
}));

vi.mock('sst', () => ({
  Resource: { websocket: { managementEndpoint: 'https://ws.example.com/dev' } },
}));

const { connectFunc, disconnectFunc, subscribeFunc, unsubscribeFunc } = vi.hoisted(() => ({
  connectFunc: vi.fn().mockResolvedValue({ statusCode: 200 }),
  disconnectFunc: vi.fn().mockResolvedValue({ statusCode: 200 }),
  subscribeFunc: vi.fn().mockResolvedValue({ statusCode: 200 }),
  unsubscribeFunc: vi.fn().mockResolvedValue({ statusCode: 200 }),
}));
vi.mock('@server/websocket/connect', () => ({ func: connectFunc }));
vi.mock('@server/websocket/disconnect', () => ({ func: disconnectFunc }));
vi.mock('@server/websocket/dataSubscribeRequest', () => ({ func: subscribeFunc }));
vi.mock('@server/websocket/dataUnsubscribeRequest', () => ({ func: unsubscribeFunc }));

import handler from '../[action]';

const SECRET = 'internal-ws-secret-value';

const makeRes = () => {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
};

const callBridge = (action: string, body: Record<string, unknown>) => {
  const req = {
    query: { action },
    headers: { 'x-internal-ws-secret': SECRET },
    body,
  };
  const res = makeRes();
  return (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res).then(() => res);
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.B4M_SELF_HOST = 'true';
  process.env.INTERNAL_WS_SECRET = SECRET;
});

describe('self-host ws bridge: connect', () => {
  it('forwards the browser ticket as queryStringParameters.ticket (not token)', async () => {
    await callBridge('connect', { connectionId: 'c1', ticket: 'single-use-ticket' });

    expect(connectFunc).toHaveBeenCalledOnce();
    const event = connectFunc.mock.calls[0][0] as { queryStringParameters: Record<string, string> };
    // connect.func's resolveWebTicket reads queryStringParameters.ticket; forwarding it under any
    // other key (the old `token`) leaves the browser socket credential-less and rejected.
    expect(event.queryStringParameters).toEqual({ ticket: 'single-use-ticket' });
    expect(event.queryStringParameters).not.toHaveProperty('token');
  });

  it('forwards no query params when the browser sent no ticket (CLI header path)', async () => {
    await callBridge('connect', {
      connectionId: 'c2',
      headers: { 'sec-websocket-protocol': 'access_token.jwt' },
    });

    const event = connectFunc.mock.calls[0][0] as {
      queryStringParameters: Record<string, string>;
      headers: Record<string, string>;
    };
    expect(event.queryStringParameters).toEqual({});
    expect(event.headers).toEqual({ 'sec-websocket-protocol': 'access_token.jwt' });
  });

  it('rejects a request with a bad internal secret', async () => {
    const req = {
      query: { action: 'connect' },
      headers: { 'x-internal-ws-secret': 'wrong-length-secret-xxxxxx' },
      body: { connectionId: 'c3', ticket: 't' },
    };
    const res = makeRes();
    await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
    expect(res.statusCode).toBe(401);
    expect(connectFunc).not.toHaveBeenCalled();
  });
});

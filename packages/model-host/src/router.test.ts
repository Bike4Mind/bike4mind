import type { IncomingMessage, ServerResponse } from 'node:http';
import { MODEL_HOST_ROLES, type ModelHostRole } from '@bike4mind/common/modelHub';
import { describe, expect, it, vi } from 'vitest';
import { createRouter, MAX_ECHOED_PATH, roleAllows, type Route } from './router';
import { HttpError } from './server';

function call(routes: Route[], method: string, url: string, role: ModelHostRole) {
  const req = { method, url } as IncomingMessage;
  return createRouter(routes)({ req, res: {} as ServerResponse, conn: { role, login: null }, body: Buffer.alloc(0) });
}

describe('createRouter', () => {
  const handle = vi.fn();
  const routes: Route[] = [
    { method: 'GET', path: '/v1/host', role: 'chat', handle },
    { method: 'GET', path: '/v1/jobs', role: 'manage', handle },
    { method: 'POST', path: '/v1/jobs', role: 'manage', handle },
    { method: 'PUT', path: '/v1/settings', role: 'admin', handle },
  ];

  it('runs a route for its role and every role above it, ignoring the query string', async () => {
    await call(routes, 'GET', '/v1/host?x=1', 'chat');
    await call(routes, 'GET', '/v1/jobs', 'admin');
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('refuses a lower role with 403, an unknown path with 404 and another method with 405', async () => {
    await expect(call(routes, 'PUT', '/v1/settings', 'manage')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    await expect(call(routes, 'GET', '/v1/nope', 'admin')).rejects.toMatchObject({ status: 404 });
    const wrongMethod = call(routes, 'DELETE', '/v1/jobs', 'admin');
    await expect(wrongMethod).rejects.toBeInstanceOf(HttpError);
    await expect(wrongMethod).rejects.toMatchObject({ status: 405, headers: { allow: 'GET, POST' } });
  });

  it('matches a parameter segment, decoding it, but never an empty or extra segment', async () => {
    const byId = vi.fn();
    const withParams: Route[] = [
      { method: 'DELETE', path: '/v1/models/:name', role: 'manage', handle: byId },
      { method: 'POST', path: '/v1/jobs/:id/cancel', role: 'manage', handle: byId },
    ];
    await call(withParams, 'DELETE', '/v1/models/hf.co%2Forg%2Frepo%3AQ4_K_M', 'manage');
    expect(byId.mock.calls[0][0].params).toEqual({ name: 'hf.co/org/repo:Q4_K_M' });
    await call(withParams, 'POST', '/v1/jobs/abc/cancel', 'admin');
    expect(byId.mock.calls[1][0].params).toEqual({ id: 'abc' });
    await expect(call(withParams, 'DELETE', '/v1/models/', 'manage')).rejects.toMatchObject({ status: 404 });
    await expect(call(withParams, 'DELETE', '/v1/models/a/b', 'manage')).rejects.toMatchObject({ status: 404 });
    await expect(call(withParams, 'DELETE', '/v1/models/%E0%A4%A', 'manage')).rejects.toMatchObject({ status: 404 });
    await expect(call(withParams, 'POST', '/v1/jobs/abc/cancel', 'chat')).rejects.toMatchObject({ status: 403 });
  });

  it('echoes at most 200 characters of an unknown path', async () => {
    const long = `/${'a'.repeat(5_000)}`;
    await expect(call(routes, 'GET', long, 'admin')).rejects.toMatchObject({
      status: 404,
      message: `No route ${long.slice(0, MAX_ECHOED_PATH)}....`,
    });
  });
});

describe('roleAllows', () => {
  it('orders chat below manage below admin', () => {
    const table = MODEL_HOST_ROLES.map(have => MODEL_HOST_ROLES.map(need => roleAllows(have, need)));
    expect(table).toEqual([
      [true, false, false],
      [true, true, false],
      [true, true, true],
    ]);
  });
});

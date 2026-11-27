// @vitest-environment node
/**
 * Drives the real baseApi chain (including the real JWT `auth`) to pin the metadata on the one
 * req-timing line each prod request emits: the response status, and the user when signed in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  lines: [] as { message: string; meta: Record<string, unknown> }[],
}));

vi.mock('@server/middlewares/logging', () => ({
  // Records every logger line with the metadata attached to it.
  logging: (req: { logger?: unknown }, _res: unknown, next: () => void) => {
    const write = (meta: Record<string, unknown>) => ({
      info: (message: string) => h.lines.push({ message, meta }),
    });
    req.logger = { ...write({}), withMetadata: write };
    next();
  },
}));
vi.mock('@bike4mind/server-utils/utils/config', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  isDevelopment: () => false,
}));
vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { baseApi } from './baseApi';

const timing = () => h.lines.filter(l => l.message === 'req-timing').map(l => l.meta);

// `never` casts: node-mocks-http req/res are not structurally the Express types the handler is typed for.
async function call(handler: (req: never, res: never) => unknown, req: Record<string, unknown> = {}) {
  const { req: request, res } = createMocks({ method: 'GET', url: '/api/x', ...req }, { eventEmitter: EventEmitter });
  await handler(request as never, res as never);
  return res;
}

describe('baseApi req-timing metadata', () => {
  beforeEach(() => {
    h.lines.length = 0;
  });

  it('records 200 and no userId for an anonymous route', async () => {
    const handler = baseApi({ auth: false }).get((_req, res) => {
      res.status(200).json({ ok: true });
    });
    const res = await call(handler);
    res.emit('finish');

    expect(timing()).toEqual([expect.objectContaining({ status: 200, aborted: false, headersSent: true })]);
    expect(timing()[0]).not.toHaveProperty('userId');
  });

  it('records a directly written 403', async () => {
    const handler = baseApi({ auth: false }).get((_req, res) => {
      res.status(403).json({ error: 'nope' });
    });
    const res = await call(handler);
    res.emit('finish');

    expect(timing()).toEqual([expect.objectContaining({ status: 403 })]);
  });

  it('records the 401 the real auth middleware writes, with no userId', async () => {
    const handler = baseApi().get((_req, res) => {
      res.status(200).json({ ok: true });
    });
    const res = await call(handler);
    res.emit('finish');

    expect(res._getStatusCode()).toBe(401);
    expect(timing()).toEqual([expect.objectContaining({ status: 401 })]);
    expect(timing()[0]).not.toHaveProperty('userId');
  });

  it('records userId when the request is signed in', async () => {
    const withUser = baseApi({ auth: false })
      .use((req, _res, next) => {
        req.user = { id: 'user-1' } as typeof req.user;
        next();
      })
      .get((_req, res) => {
        res.status(200).json({ ok: true });
      });
    const res = await call(withUser);
    res.emit('finish');

    expect(timing()).toEqual([expect.objectContaining({ status: 200, userId: 'user-1' })]);
  });

  it('marks a client disconnect as aborted with no headers sent', async () => {
    let reached!: () => void;
    const inHandler = new Promise<void>(resolve => (reached = resolve));
    const handler = baseApi({ auth: false }).get(() => reached());
    const { req, res } = createMocks({ method: 'GET', url: '/api/x' }, { eventEmitter: EventEmitter });
    void handler(req as never, res as never); // never responds, so it must not be awaited
    await inHandler;
    res.emit('close');

    expect(timing()).toEqual([expect.objectContaining({ aborted: true, headersSent: false })]);
  });

  it('emits exactly one line when finish is followed by close', async () => {
    const handler = baseApi({ auth: false }).get((_req, res) => {
      res.status(200).json({});
    });
    const res = await call(handler);
    res.emit('finish');
    res.emit('close');

    expect(timing()).toHaveLength(1);
  });
});

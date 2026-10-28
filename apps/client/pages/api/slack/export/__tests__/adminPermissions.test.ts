// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const state = vi.hoisted(() => ({ guard: undefined as unknown, options: undefined as unknown }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    state.options = options;
    const chain: Record<string, unknown> = {};
    for (const m of ['get', 'post', 'patch', 'delete', 'put']) chain[m] = () => chain;
    chain.use = (fn: unknown) => {
      if (!state.guard) state.guard = fn;
      return chain;
    };
    return chain;
  },
}));

type Case = { file: string; method: 'GET' | 'POST' | 'DELETE'; permission: string };
const cases: Case[] = [
  { file: '../async', method: 'POST', permission: 'settings:manage' },
  { file: '../async', method: 'GET', permission: 'settings:manage' },
  { file: '../channel', method: 'POST', permission: 'settings:manage' },
  { file: '../channel-info', method: 'POST', permission: 'settings:manage' },
  { file: '../status/[jobId]', method: 'GET', permission: 'settings:manage' },
  { file: '../status/[jobId]', method: 'DELETE', permission: 'settings:manage' },
];

const runGuard = (method: string, user: Record<string, unknown>) => {
  const next = vi.fn();
  (state.guard as (req: Request, res: Response, next: () => void) => void)(
    { method, user } as unknown as Request,
    {} as Response,
    next
  );
  return next;
};

beforeEach(() => {
  state.guard = undefined;
  vi.resetModules();
});

describe.each(cases)('$file ($method)', ({ file, method, permission }) => {
  const load = async () => {
    state.guard = undefined;
    await import(/* @vite-ignore */ file);
  };

  it('allows a delegate holding the declared permission without isAdmin', async () => {
    await load();
    expect(runGuard(method, { isAdmin: false, adminPermissions: [permission] })).toHaveBeenCalledOnce();
  });

  it('rejects a delegate holding a different permission', async () => {
    await load();
    const other = permission === 'support:read' ? 'settings:manage' : 'support:read';
    expect(() => runGuard(method, { isAdmin: false, adminPermissions: [other] })).toThrow(
      `Missing permission: ${permission}`
    );
  });

  it('rejects a non-admin with no permissions', async () => {
    await load();
    expect(() => runGuard(method, { isAdmin: false })).toThrow();
  });

  it('allows a full admin', async () => {
    await load();
    expect(runGuard(method, { isAdmin: true })).toHaveBeenCalledOnce();
  });
});

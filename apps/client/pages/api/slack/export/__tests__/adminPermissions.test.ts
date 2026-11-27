// @vitest-environment node
import { beforeAll, vi } from 'vitest';
import { describeAdminPermissionCases, type AdminPermissionCase } from '@server/__tests__/adminPermissionsHarness';

const state = vi.hoisted(() => ({ guard: undefined as unknown, options: undefined as unknown }));

vi.mock('@server/middlewares/baseApi', async () =>
  (await import('@server/__tests__/adminPermissionsHarness')).baseApiMock(state)
);

const cases: AdminPermissionCase[] = [
  { file: '../async', method: 'POST', permission: 'settings:manage', allowedMethods: ['POST', 'GET'] },
  { file: '../async', method: 'GET', permission: 'settings:manage', allowedMethods: ['POST', 'GET'] },
  { file: '../channel', method: 'POST', permission: 'settings:manage' },
  { file: '../channel-info', method: 'POST', permission: 'settings:manage' },
  { file: '../status/[jobId]', method: 'GET', permission: 'settings:manage', allowedMethods: ['GET', 'DELETE'] },
  { file: '../status/[jobId]', method: 'DELETE', permission: 'settings:manage', allowedMethods: ['GET', 'DELETE'] },
];

// Each route is imported once up front: a re-import after the harness's resetModules re-evaluates the route's whole
// dependency graph. Distinct routes do not need a reset, since each builds its own adminApi chain.
const captured = new Map<string, { guard: unknown; options: unknown }>();

beforeAll(async () => {
  for (const file of new Set(cases.map(c => c.file))) {
    state.guard = undefined;
    state.options = undefined;
    await import(/* @vite-ignore */ file);
    captured.set(file, { guard: state.guard, options: state.options });
  }
});

describeAdminPermissionCases(cases, state, async file => {
  const route = captured.get(file);
  if (!route) throw new Error(`Route ${file} was not preloaded`);
  Object.assign(state, route);
});

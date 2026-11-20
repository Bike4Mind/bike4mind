// @vitest-environment node
import { vi } from 'vitest';
import { describeAdminPermissionCases, type AdminPermissionCase } from '@server/__tests__/adminPermissionsHarness';

const state = vi.hoisted(() => ({ guard: undefined as unknown, options: undefined as unknown }));

vi.mock('@server/middlewares/baseApi', async () =>
  (await import('@server/__tests__/adminPermissionsHarness')).baseApiMock(state)
);

const cases: AdminPermissionCase[] = [
  { file: '../index', method: 'GET', permission: 'credits:adjust' },
  { file: '../waiting-count', method: 'GET', permission: 'credits:adjust' },
  { file: '../[id]/delete', method: 'DELETE', permission: 'credits:adjust' },
];

describeAdminPermissionCases(cases, state, file => import(/* @vite-ignore */ file));

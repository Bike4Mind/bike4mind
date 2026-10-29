// @vitest-environment node
import { vi } from 'vitest';
import { describeAdminPermissionCases, type AdminPermissionCase } from '@server/__tests__/adminPermissionsHarness';

const state = vi.hoisted(() => ({ guard: undefined as unknown, options: undefined as unknown }));

vi.mock('@server/middlewares/baseApi', async () =>
  (await import('@server/__tests__/adminPermissionsHarness')).baseApiMock(state)
);

const cases: AdminPermissionCase[] = [
  { file: '../slack-workspaces', method: 'GET', permission: 'settings:manage', allowedMethods: ['GET', 'PATCH'] },
  { file: '../slack-workspaces', method: 'PATCH', permission: 'settings:manage', allowedMethods: ['GET', 'PATCH'] },
];

describeAdminPermissionCases(cases, state, file => import(/* @vite-ignore */ file));

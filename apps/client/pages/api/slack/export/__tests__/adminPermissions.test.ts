// @vitest-environment node
import { vi } from 'vitest';
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

describeAdminPermissionCases(cases, state, file => import(/* @vite-ignore */ file));

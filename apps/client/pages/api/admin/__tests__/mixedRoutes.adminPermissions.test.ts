// @vitest-environment node
import { vi } from 'vitest';
import { describeAdminPermissionCases, type AdminPermissionCase } from '@server/__tests__/adminPermissionsHarness';

const state = vi.hoisted(() => ({ guard: undefined as unknown, options: undefined as unknown }));

vi.mock('@server/middlewares/baseApi', async () =>
  (await import('@server/__tests__/adminPermissionsHarness')).baseApiMock(state)
);

const readWrite = (file: string, write: string): AdminPermissionCase[] => [
  { file, method: 'GET', permission: 'support:read', allowedMethods: ['GET', write] },
  { file, method: write, permission: 'settings:manage', allowedMethods: ['GET', write] },
];

const cases: AdminPermissionCase[] = [
  ...readWrite('../operations-model', 'PUT'),
  ...readWrite('../model-prices', 'POST'),
  ...readWrite('../provider-invoices', 'POST'),
  ...readWrite('../integration-health-dashboard', 'POST'),
  ...readWrite('../model-discovery', 'POST'),
  ...readWrite('../saved-views/index', 'POST'),
  {
    file: '../model-deprecation-status',
    method: 'GET',
    permission: 'settings:manage',
    allowedMethods: ['GET', 'POST'],
  },
  {
    file: '../model-deprecation-status',
    method: 'POST',
    permission: 'settings:manage',
    allowedMethods: ['GET', 'POST'],
  },
  { file: '../saved-views/[id]', method: 'PATCH', permission: 'settings:manage', allowedMethods: ['PATCH', 'DELETE'] },
  { file: '../saved-views/[id]', method: 'DELETE', permission: 'settings:manage', allowedMethods: ['PATCH', 'DELETE'] },
];

describeAdminPermissionCases(cases, state, file => import(/* @vite-ignore */ file));

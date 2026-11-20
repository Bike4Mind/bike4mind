// @vitest-environment node
import { vi } from 'vitest';
import { describeAdminPermissionCases, type AdminPermissionCase } from '@server/__tests__/adminPermissionsHarness';

const state = vi.hoisted(() => ({ guard: undefined as unknown, options: undefined as unknown }));

vi.mock('@server/middlewares/baseApi', async () =>
  (await import('@server/__tests__/adminPermissionsHarness')).baseApiMock(state)
);
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const blockedIps = (method: string, permission: string): AdminPermissionCase => ({
  file: '../security/blocked-ips',
  method,
  permission,
  allowedMethods: ['GET', 'POST', 'DELETE'],
});

const cases: AdminPermissionCase[] = [
  { file: '../settings/index', method: 'GET', permission: 'settings:manage' },
  { file: '../settings/update', method: 'PUT', permission: 'settings:manage' },
  blockedIps('GET', 'support:read'),
  blockedIps('POST', 'settings:manage'),
  blockedIps('DELETE', 'settings:manage'),
  { file: '../security/blocked-ips/evaluate', method: 'POST', permission: 'settings:manage' },
  { file: '../inbox/admin-send', method: 'POST', permission: 'settings:manage' },
  { file: '../auth/mfa/force-reset', method: 'POST', permission: 'users:moderate' },
  { file: '../reg-invites/update', method: 'POST', permission: 'settings:manage' },
  { file: '../reg-invites/migrate', method: 'POST', permission: 'settings:manage' },
  { file: '../admin/organizations/[id]/group-types', method: 'PUT', permission: 'settings:manage' },
];

describeAdminPermissionCases(cases, state, file => import(/* @vite-ignore */ file));

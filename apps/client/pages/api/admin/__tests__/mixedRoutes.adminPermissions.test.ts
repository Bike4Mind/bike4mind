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
  { file: '../embedding-limits', method: 'GET', permission: 'settings:manage', allowedMethods: ['GET'] },
  { file: '../system-health', method: 'GET', permission: 'settings:manage', allowedMethods: ['GET'] },
  { file: '../liveops-triage-env', method: 'GET', permission: 'settings:manage', allowedMethods: ['GET'] },
  { file: '../system-secrets/tier1-status', method: 'GET', permission: 'settings:manage', allowedMethods: ['GET'] },
  { file: '../system-secrets/index', method: 'GET', permission: 'settings:manage', allowedMethods: ['GET', 'POST'] },
  { file: '../system-secrets/[id]', method: 'GET', permission: 'settings:manage', allowedMethods: ['GET', 'DELETE'] },
  {
    file: '../agent-ops-settings',
    method: 'GET',
    permission: 'settings:manage',
    allowedMethods: ['GET', 'PUT', 'POST'],
  },
  {
    file: '../whats-new-highlights-config',
    method: 'GET',
    permission: 'settings:manage',
    allowedMethods: ['GET', 'PUT'],
  },
  { file: '../release-notes/config', method: 'GET', permission: 'settings:manage', allowedMethods: ['GET', 'PUT'] },
  ...['GET', 'POST', 'PUT', 'DELETE'].map(method => ({
    file: '../team-members',
    method,
    permission: 'settings:manage',
    allowedMethods: ['GET', 'POST', 'PUT', 'DELETE'],
  })),
  { file: '../create-user', method: 'POST', permission: 'settings:manage' },
  { file: '../bulk-create-users', method: 'POST', permission: 'settings:manage' },
  { file: '../sessions/[id]/index', method: 'GET', permission: 'support:read' },
  { file: '../sessions/[id]/quests', method: 'GET', permission: 'support:read' },
];

describeAdminPermissionCases(cases, state, file => import(/* @vite-ignore */ file));

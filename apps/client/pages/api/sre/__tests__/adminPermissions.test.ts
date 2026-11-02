// @vitest-environment node
import { vi } from 'vitest';
import { describeAdminPermissionCases, type AdminPermissionCase } from '@server/__tests__/adminPermissionsHarness';

const state = vi.hoisted(() => ({ guard: undefined as unknown, options: undefined as unknown }));

vi.mock('@server/middlewares/baseApi', async () =>
  (await import('@server/__tests__/adminPermissionsHarness')).baseApiMock(state)
);
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => vi.fn() }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sreErrorTrackingRepository: {},
}));
vi.mock('@bike4mind/database/infra', () => ({}));
vi.mock('@bike4mind/server-utils/services/githubService', () => ({ GitHubService: {} }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn() }));
vi.mock('@bike4mind/server-utils/integrations/github/sreWebhookDispatch', () => ({}));

const cases: AdminPermissionCase[] = [
  { file: '../metrics', method: 'GET', permission: 'support:read' },
  { file: '../patterns', method: 'GET', permission: 'support:read' },
  { file: '../tracking', method: 'GET', permission: 'support:read' },
  { file: '../tracking/[id]/index', method: 'GET', permission: 'support:read' },
  { file: '../tracking/[id]/issue-state', method: 'GET', permission: 'support:read' },
  { file: '../scan', method: 'POST', permission: 'settings:manage' },
  { file: '../trigger', method: 'POST', permission: 'settings:manage' },
  { file: '../tracking/[id]/dismiss', method: 'POST', permission: 'settings:manage' },
  { file: '../tracking/[id]/rerun', method: 'POST', permission: 'settings:manage' },
  { file: '../tracking/[id]/retry', method: 'POST', permission: 'settings:manage' },
  { file: '../patterns/[id]', method: 'PATCH', permission: 'settings:manage' },
];

describeAdminPermissionCases(cases, state, file => import(/* @vite-ignore */ file));

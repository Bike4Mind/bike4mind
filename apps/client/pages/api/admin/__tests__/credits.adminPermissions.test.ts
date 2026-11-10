// @vitest-environment node
import { vi } from 'vitest';
import { describeAdminPermissionCases, type AdminPermissionCase } from '@server/__tests__/adminPermissionsHarness';

const state = vi.hoisted(() => ({ guard: undefined as unknown, options: undefined as unknown }));

vi.mock('@server/middlewares/baseApi', async () =>
  (await import('@server/__tests__/adminPermissionsHarness')).baseApiMock(state)
);

/** A credits page read: support:read or credits:adjust, and nothing else. */
const read = (file: string, allowedMethods = ['GET']): AdminPermissionCase[] => [
  { file, method: 'GET', permission: 'support:read', allowedMethods },
  { file, method: 'GET', permission: 'credits:adjust', allowedMethods, rejectedPermission: 'settings:manage' },
];

const write = (file: string, method: string, allowedMethods = [method]): AdminPermissionCase => ({
  file,
  method,
  permission: 'credits:adjust',
  allowedMethods,
});

const cases: AdminPermissionCase[] = [
  write('../users/[userId]/grant-subscription', 'POST'),
  write('../users/[userId]/subscriptions/[subscriptionId]/credits', 'PUT'),
  write('../users/[userId]/subscriptions/[subscriptionId]/remove', 'DELETE'),
  write('../users/[userId]/new-account-spend-cap', 'POST'),
  write('../users/[userId]/unlock-signup-grant', 'POST'),
  write('../held-signup-grants/release', 'POST'),
  write('../held-signup-grants/revoke', 'POST'),
  write('../subscriptions/[id]/comp', 'POST'),
  write('../subscriptions/[id]/sync', 'POST', ['GET', 'POST']),
  write('../subscriptions/[id]/cancel', 'POST'),
  write('../subscriptions/[id]/resume', 'POST'),
  write('../organizations/grant', 'POST'),
  write('../organizations/[id]/top-up', 'POST'),
  write('../organizations/[id]/seats', 'PATCH'),
  write('../organizations/[id]/convert-to-paid', 'POST'),
  write('../organizations/[id]/revoke', 'POST'),
  ...read('../subscriptions/[id]/sync', ['GET', 'POST']),
  ...read('../users/[userId]/entitlements'),
  ...read('../users/[userId]/credit-history'),
  ...read('../users/[userId]/credit-ledger'),
  ...read('../users/[userId]/credit-ledger-export'),
  ...read('../users/[userId]/credit-summary'),
  ...read('../users/[userId]/credit-transactions'),
  ...read('../users/[userId]/subscriptions'),
  ...read('../held-signup-grants/index'),
  ...read('../credit-adjustments'),
  ...read('../organizations/grants'),
  ...read('../subscriptions/index'),
  ...read('../subscriptions/summary'),
  ...read('../subscriptions/export'),
  ...read('../subscriptions/by-stripe/[stripeSubscriptionId]'),
  ...read('../subscriptions/[id]/index'),
  ...read('../subscriptions/[id]/admin-log'),
  ...read('../subscriptions/[id]/timeline'),
];

describeAdminPermissionCases(cases, state, file => import(/* @vite-ignore */ file));

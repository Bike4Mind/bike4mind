import { randomBytes } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import type { BulkAbuseActions, BulkAbuseExecuteResult, BulkAbusePreview } from '@bike4mind/common';
import { test, expect } from '../fixtures';
import { apiCreateTestUser, apiDeleteGrantedTeam, apiGrantTeam, apiUpdateUser } from '../helpers/api';
import { guardLaunchReadiness } from './guard';
import {
  adminReadUser,
  adminToken,
  apiUrl,
  freshIdentity,
  liveSetting,
  registerFreshAccount,
  settledSignupGrant,
} from './support';

guardLaunchReadiness();

const BAN_ACTIONS: BulkAbuseActions = {
  ban: true,
  revokeApiKeys: false,
  revokeSessions: true,
  clawbackFreeCredits: true,
};
const REASON = 'Launch-readiness e2e: acting only on accounts this test created';

async function bulkPreview(request: APIRequestContext, userIds: string[], actions: BulkAbuseActions) {
  const res = await request.post(`${apiUrl()}/api/admin/abuse/bulk-preview`, {
    headers: { Authorization: `Bearer ${adminToken()}` },
    data: { target: { kind: 'users', userIds }, actions },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as BulkAbusePreview;
}

async function bulkExecute(
  request: APIRequestContext,
  userIds: string[],
  actions: BulkAbuseActions,
  previewToken: string
) {
  const res = await request.post(`${apiUrl()}/api/admin/abuse/bulk-execute`, {
    headers: { Authorization: `Bearer ${adminToken()}` },
    data: { target: { kind: 'users', userIds }, actions, previewToken, reason: REASON },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as BulkAbuseExecuteResult;
}

test.describe('A1.7 bulk abuse tooling', () => {
  test('A1.7 the dry run counts free accounts and skips admins, org owners, paid accounts and unknown ids', async ({
    request,
  }) => {
    test.slow();
    const free = [
      await registerFreshAccount(request, freshIdentity('a17free1')),
      await registerFreshAccount(request, freshIdentity('a17free2')),
    ];
    const paid = await registerFreshAccount(request, freshIdentity('a17paid'));
    await apiUpdateUser(request, adminToken(), paid.userId, { level: 'PaidUser' });
    const owner = await registerFreshAccount(request, freshIdentity('a17owner'));
    const adminIdentity = freshIdentity('a17admin');
    const admin = await apiCreateTestUser(request, {
      ...adminIdentity,
      name: 'Launch readiness admin',
      password: `Lr${randomBytes(9).toString('base64url')}9!`,
      isAdmin: true,
    });
    const adminId = (admin.user.id || admin.user._id) as string;
    const unknownId = randomBytes(12).toString('hex');

    const organizationId = await apiGrantTeam(request, adminToken(), {
      name: `lr-a17-${owner.userId.slice(-6)}`,
      ownerEmail: owner.email,
      seats: 2,
    });
    try {
      const preview = await bulkPreview(
        request,
        [...free.map(account => account.userId), paid.userId, owner.userId, adminId, unknownId],
        BAN_ACTIONS
      );

      expect(preview.includedCount).toBe(free.length);
      expect(preview.previewToken).toBeTruthy();
      expect(preview.sample.map(user => user.id).sort()).toEqual(free.map(account => account.userId).sort());
      const reasons = Object.fromEntries(preview.excluded.map(entry => [entry.userId, entry.reason]));
      expect(reasons).toEqual({
        [paid.userId]: 'paid',
        [owner.userId]: 'org_owner',
        [adminId]: 'admin',
        [unknownId]: 'not_found',
      });
      for (const account of free) expect((await adminReadUser(request, account.userId)).isBanned).toBeFalsy();
    } finally {
      await apiDeleteGrantedTeam(request, adminToken(), organizationId).catch(() => undefined);
    }
  });

  test('A1.7 the real run bans what the dry run showed and reads back as banned with sessions revoked', async ({
    request,
  }) => {
    const accounts = [
      await registerFreshAccount(request, freshIdentity('a17ban1')),
      await registerFreshAccount(request, freshIdentity('a17ban2')),
    ];
    const userIds = accounts.map(account => account.userId);
    const preview = await bulkPreview(request, userIds, BAN_ACTIONS);
    expect(preview.includedCount).toBe(accounts.length);

    const result = await bulkExecute(request, userIds, BAN_ACTIONS, preview.previewToken);

    expect(result.failedCount).toBe(0);
    expect(result.succeededCount).toBe(accounts.length);
    expect(result.bannedCount).toBe(accounts.length);
    expect(result.clawedBackCredits).toBe(preview.clawbackCredits);
    for (const account of accounts) {
      expect((await adminReadUser(request, account.userId)).isBanned).toBe(true);
      const stale = await request.get(`${apiUrl()}/api/users/${account.userId}`, {
        headers: { Authorization: `Bearer ${account.accessToken}` },
      });
      expect(stale.status(), 'the session from before the ban').toBeGreaterThanOrEqual(400);
    }
  });

  test('A1.7 the real run claws back the signup grant and the balance reads back lower', async ({ request }) => {
    const initialCredits = await liveSetting<number>(request, 'signupGrantInitialCredits');
    test.skip(
      !initialCredits,
      'The stage grants no credits at verification (signupGrantInitialCredits is 0), so there is nothing to claw back'
    );
    const account = await registerFreshAccount(request, freshIdentity('a17claw'));
    const before = (await settledSignupGrant(request, account.userId)).currentCredits ?? 0;
    test.skip(
      before === 0,
      'The signup tranche was held or scored down to 0 on this stage, so there is nothing to claw back'
    );

    const clawback: BulkAbuseActions = {
      ban: false,
      revokeApiKeys: false,
      revokeSessions: false,
      clawbackFreeCredits: true,
    };
    const preview = await bulkPreview(request, [account.userId], clawback);
    expect(preview.clawbackCredits).toBeGreaterThan(0);
    const result = await bulkExecute(request, [account.userId], clawback, preview.previewToken);

    expect(result.clawedBackCredits).toBe(preview.clawbackCredits);
    expect(result.results[0]?.steps.clawbackFreeCredits).toBe('applied');
    expect((await adminReadUser(request, account.userId)).currentCredits).toBe(before - result.clawedBackCredits);
  });
});

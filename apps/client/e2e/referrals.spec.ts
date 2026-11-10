import { expect, test } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { apiCreateTestUser, apiDeleteInviteCode, apiGetOtcCode } from './helpers/api';
import { getE2ETestId, getTestRunId, getTestUsers } from './helpers/test-users';

// Referral invites: quota reservation, invite redemption during email-code signup, and the saved inviter.
interface RegInviteRow {
  id?: string;
  _id?: string;
  userId?: string;
  email?: string;
  code: string;
  status?: string;
  source?: string;
  used?: string;
  usedbyId?: string;
}

interface ReferralState {
  numReferralsAvailable?: number;
  regInvites?: string[];
  referredByUserId?: string | null;
}

const apiUrl = () => process.env.API_URL || 'http://localhost:3000';

/** Self view of the account; it carries the referral quota, sent invites and the saved inviter. */
async function readReferralState(request: APIRequestContext, token: string, userId: string): Promise<ReferralState> {
  const res = await request.get(`${apiUrl()}/api/users/${userId}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok()).toBe(true);
  return (await res.json()) as ReferralState;
}

/** Admin-only, unfiltered list (the route ignores query params), so callers filter by email + sender. */
async function findReferralInvites(request: APIRequestContext, inviterId: string, email: string) {
  const res = await request.get(`${apiUrl()}/api/reg-invites`, {
    headers: { Authorization: `Bearer ${getTestUsers().admin.accessToken}` },
  });
  expect(res.ok()).toBe(true);
  const rows = (await res.json()) as RegInviteRow[];
  return rows.filter(r => r.email === email && String(r.userId) === inviterId);
}

async function refer(request: APIRequestContext, token: string, friendEmail: string[]) {
  return request.post(`${apiUrl()}/api/reg-invites/refer`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { userName: 'E2E Referrer', friendEmail, emailTitle: 'Join me', emailBody: 'E2E referral invite' },
  });
}

// No open-registration gate (unlike signup.spec.ts): an invite code is the signup path on invite-only
// instances, and the register page renders the invite field either way.
test.describe('Referrals & invites', () => {
  test('referral invite reserves quota, is redeemed during email-code signup, and saves the inviter', async ({
    basePage,
    signupPage,
    page,
    request,
  }) => {
    const e2eId = getE2ETestId();
    const idSuffix = e2eId ? `${e2eId}-${getTestRunId()}` : getTestRunId();
    const stamp = Date.now();
    const inviteeEmail = `refinvitee${stamp}-${idSuffix}-e2e@test.com`;

    // Created accounts skip the email-code flow, so pre-verify the inviter and clear the new-account
    // trust gate: /api/reg-invites/refer refuses an unverified or untrusted sender.
    const inviter = await apiCreateTestUser(request, {
      username: `refinviter${stamp}-${idSuffix}`,
      email: `refinviter${stamp}-${idSuffix}-e2e@test.com`,
      name: 'E2E Referrer',
      password: `E2eRefer${stamp}Pass!`,
      emailVerified: true,
      apiKeyTrustApproved: true,
    });
    const inviterId = (inviter.user.id || inviter.user._id) as string;
    const inviterToken = inviter.accessToken;

    const inviteIds: string[] = [];
    try {
      // --- Invite quota reserved ---
      const before = await readReferralState(request, inviterToken, inviterId);
      const startQuota = before.numReferralsAvailable ?? 0;
      expect(startQuota).toBeGreaterThanOrEqual(1);

      // The same address twice (once upper-cased) is deduplicated before the reservation, so it costs one referral.
      const referRes = await refer(request, inviterToken, [inviteeEmail, inviteeEmail.toUpperCase()]);
      expect(referRes.status()).toBe(201);
      expect(((await referRes.json()) as { sent: string[] }).sent).toEqual([inviteeEmail]);

      const afterRefer = await readReferralState(request, inviterToken, inviterId);
      expect(afterRefer.numReferralsAvailable).toBe(startQuota - 1);

      const invites = await findReferralInvites(request, inviterId, inviteeEmail);
      inviteIds.push(...invites.map(r => (r.id || r._id) as string));
      expect(invites).toHaveLength(1);
      const [invite] = invites;
      const inviteId = inviteIds[0];
      expect(invite.source).toBe('referral');
      expect(invite.status).toBe('open');
      expect(invite.used).toBeFalsy();
      expect(afterRefer.regInvites).toContain(inviteId);

      // Asking for more invites than remain is refused at the atomic reservation: nothing is charged
      // and no invite is minted for the refused addresses.
      const remaining = afterRefer.numReferralsAvailable ?? 0;
      const overflow = Array.from({ length: remaining + 1 }, (_, i) => `refover${i}x${stamp}-${idSuffix}-e2e@test.com`);
      const overRes = await refer(request, inviterToken, overflow);
      expect(overRes.status()).toBe(400);
      expect(await overRes.text()).toContain('Not enough referrals available');
      expect((await readReferralState(request, inviterToken, inviterId)).numReferralsAvailable).toBe(remaining);
      expect(await findReferralInvites(request, inviterId, overflow[0])).toHaveLength(0);

      // --- Invite redeemed during email-code signup ---
      await basePage.clearAllStorage();
      await signupPage.goto();
      await signupPage.fillUsername(`refinvitee${stamp}-${idSuffix}`);
      await signupPage.fillEmail(inviteeEmail);
      await signupPage.fillInviteCode(invite.code);
      await signupPage.acceptPolicies();
      await signupPage.submit();
      await signupPage.expectOtcStep();

      await signupPage.fillOtc(await apiGetOtcCode(request, inviteeEmail));
      const verified = page.waitForResponse(
        r => r.url().includes('/api/otc/verify') && r.request().method() === 'POST'
      );
      await signupPage.verify();
      const verifyRes = await verified;
      expect(verifyRes.request().postDataJSON()).toMatchObject({ email: inviteeEmail, inviteCode: invite.code });
      expect(verifyRes.ok()).toBe(true);
      const { user: invitee, accessToken: inviteeToken } = (await verifyRes.json()) as {
        user: { id: string; referredByUserId?: string | null };
        accessToken: string;
      };
      await basePage.dismissModals();
      await expect(page).not.toHaveURL(/.*(login|register).*/);

      const [redeemed] = await findReferralInvites(request, inviterId, inviteeEmail);
      expect(redeemed.status).toBe('used');
      expect(redeemed.used).toBeTruthy();
      expect(String(redeemed.usedbyId)).toBe(invitee.id);

      // --- Inviter saved at signup ---
      expect(invitee.referredByUserId).toBe(inviterId);
      expect((await readReferralState(request, inviteeToken, invitee.id)).referredByUserId).toBe(inviterId);
    } finally {
      // The cleanup sweep removes the -e2e accounts but not the invite rows they point at.
      for (const id of inviteIds) {
        await apiDeleteInviteCode(request, getTestUsers().admin.accessToken, id).catch(err => {
          console.warn(`Failed to delete referral invite ${id}:`, err);
        });
      }
    }
  });
});

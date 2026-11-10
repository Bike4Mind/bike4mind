import { canonicalizeEmail } from '@bike4mind/common';
import { test, expect } from '../fixtures';
import { apiLoginViaOtc } from '../helpers/api';
import { guardLaunchReadiness, canChangeSettings, isSingleWorkerRun, SETTINGS_WRITE_SKIP } from './guard';
import {
  adminReadUser,
  discardSignupInvite,
  freshIdentity,
  liveSetting,
  postOtcRegistration,
  registerFreshAccount,
  signupInviteIfNeeded,
  withSettings,
} from './support';

guardLaunchReadiness();

const READBACK_ONLY_TEST_INBOX =
  'the OTC code readback serves only -e2e@test.com addresses, so no other domain can complete a registration here';

test.describe('A1.4 email identity at signup', () => {
  test('A1.4 dot and plus aliases earn no second grant', async ({ request }) => {
    const base = freshIdentity('a14base');
    const plusAlias = freshIdentity('a14base', 'alias');
    const dotAlias = { ...base, email: base.email.replace('a14base', 'a14.base') };
    const canonical = canonicalizeEmail(base.email);
    test.skip(
      canonicalizeEmail(plusAlias.email) !== canonical || canonicalizeEmail(dotAlias.email) !== canonical,
      `Aliases fold only for Gmail, the same-mailbox domains and the plus-addressing providers; test.com aliases are separate mailboxes and ${READBACK_ONLY_TEST_INBOX}. The fold is covered by canonicalEmail.test.ts`
    );

    await registerFreshAccount(request, base);
    for (const alias of [plusAlias, dotAlias]) {
      const account = await registerFreshAccount(request, { email: alias.email, username: `${alias.username}x` });
      const record = await adminReadUser(request, account.userId);
      expect(record.signupGrantAssessment?.signals?.canonicalEmailCollision).toBe(true);
      expect(record.signupGrant?.creditsReleased ?? 0).toBe(0);
    }
  });

  test('A1.4 a first signup from a fresh inbox is scored with no alias collision', async ({ request }) => {
    const account = await registerFreshAccount(request, freshIdentity('a14fresh'));
    const record = await adminReadUser(request, account.userId);
    test.skip(
      !record.signupGrantAssessment?.signals,
      'The stage did not score this signup (signupGrantRiskPolicy is off), so there is no assessment to read'
    );
    expect(record.signupGrantAssessment!.signals!.canonicalEmailCollision).toBe(false);
  });

  test('A1.4 a blocked email domain cannot register and its existing accounts still sign in', async ({ request }) => {
    test.skip(!canChangeSettings(), SETTINGS_WRITE_SKIP);
    test.skip(
      !isSingleWorkerRun(),
      'Blocks test.com, the domain every e2e signup uses, so it runs only in a single-worker run where no other test registers meanwhile'
    );

    const existing = await registerFreshAccount(request, freshIdentity('a14exist'));
    const blocked = await liveSetting<string[]>(request, 'blockedEmailDomains');

    await withSettings(request, { blockedEmailDomains: [...blocked, 'test.com'] }, async () => {
      const invite = await signupInviteIfNeeded(request);
      try {
        const res = await postOtcRegistration(request, { ...freshIdentity('a14blocked'), inviteCode: invite?.code });
        expect(res.status()).toBe(400);
        expect(await res.text()).toContain('This email domain is not allowed');
      } finally {
        await discardSignupInvite(request, invite);
      }

      const session = await apiLoginViaOtc(request, existing.email);
      expect(session.accessToken).toBeTruthy();
    });
  });

  test('A1.4 a disposable-domain signup is refused', async () => {
    test.skip(
      true,
      `Needs a registration from a domain on the disposable list, and ${READBACK_ONLY_TEST_INBOX}. The list match is covered by disposableEmail.test.ts`
    );
  });

  test('A1.4 a signup from a recently registered domain is held', async () => {
    test.skip(
      true,
      `Needs a registration from a domain registered within the young-domain window (test.com is decades old), and ${READBACK_ONLY_TEST_INBOX}`
    );
  });
});

import { test, expect } from '../fixtures';
import { guardLaunchReadiness } from './guard';
import { freshIdentity, liveSetting, registerFreshAccount, settledSignupGrant } from './support';

guardLaunchReadiness();

test.describe('A2.1 staged signup grant', () => {
  test('A2.1 a fresh account holds no more than the first tranche after verification', async ({ request }) => {
    const firstTranche = await liveSetting<number>(request, 'signupGrantInitialCredits');
    const account = await registerFreshAccount(request, freshIdentity('a21cap'));
    const record = await settledSignupGrant(request, account.userId);

    expect(record.signupGrant, 'the account is enrolled in the staged grant, not paid a flat amount').toBeDefined();
    expect(record.signupGrant!.signupCredits).toBeLessThanOrEqual(firstTranche);
    // An invite may pay its bonus at signup on top of the tranche; that is the only other source allowed.
    const inviteBonus = record.signupGrant!.inviteBonusPaid ?? 0;
    expect(record.currentCredits ?? 0).toBeLessThanOrEqual(firstTranche + inviteBonus);
  });

  test("A2.1 a fresh account's balance after verification equals the first tranche", async ({ request }) => {
    const firstTranche = await liveSetting<number>(request, 'signupGrantInitialCredits');
    const account = await registerFreshAccount(request, freshIdentity('a21eq'));
    const record = await settledSignupGrant(request, account.userId);

    test.skip(
      !!record.signupGrantHeldReason,
      `The stage held this tranche (${record.signupGrantHeldReason}), so the balance is not the tranche yet`
    );
    const band = record.signupGrantAssessment?.band;
    test.skip(
      band !== undefined && band !== 'full',
      `The risk policy scored this signup "${band}", which pays less than the first tranche by design`
    );

    expect(record.signupGrant?.signupCredits).toBe(firstTranche);
    expect(record.currentCredits ?? 0).toBe(firstTranche + (record.signupGrant?.inviteBonusPaid ?? 0));
  });
});

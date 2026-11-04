import { unlockSignupGrantFromActivity } from './activityUnlock';
import { retryOrgInviteBonus } from './orgInviteBonus';
import { unlockSignupGrantFromAcceptedOrgInvite } from './orgInviteUnlock';

export async function checkSignupGrantEligibility(userId: string) {
  try {
    const inviteRelease = await unlockSignupGrantFromAcceptedOrgInvite(userId);
    if (inviteRelease.creditsGranted > 0) return inviteRelease;
    return await unlockSignupGrantFromActivity(userId);
  } finally {
    // After the unlocks, so a tranche this call just paid makes the bonus payable in the same call.
    await retryOrgInviteBonus(userId).catch(() => {
      console.warn('[signup-grant] Organization invite bonus retry failed');
    });
  }
}

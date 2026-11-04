import { unlockSignupGrantFromActivity } from './activityUnlock';
import { retryOrgInviteBonus } from './orgInviteBonus';
import { unlockSignupGrantFromAcceptedOrgInvite } from './orgInviteUnlock';

export async function checkSignupGrantEligibility(userId: string) {
  try {
    await retryOrgInviteBonus(userId);
  } catch {
    console.warn('[signup-grant] Organization invite bonus retry failed');
  }
  const inviteRelease = await unlockSignupGrantFromAcceptedOrgInvite(userId);
  if (inviteRelease.creditsGranted > 0) return inviteRelease;
  return unlockSignupGrantFromActivity(userId);
}

import { unlockSignupGrantFromActivity } from './activityUnlock';
import { unlockSignupGrantFromAcceptedOrgInvite } from './orgInviteUnlock';

export async function checkSignupGrantEligibility(userId: string) {
  const inviteRelease = await unlockSignupGrantFromAcceptedOrgInvite(userId);
  if (inviteRelease.creditsGranted > 0) return inviteRelease;
  return unlockSignupGrantFromActivity(userId);
}

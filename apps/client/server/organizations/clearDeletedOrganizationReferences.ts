import {
  integrationRequestRepository,
  inviteRepository,
  orgDomainClaimRepository,
  partnerSignupRuleRepository,
} from '@bike4mind/database';
import { InviteType } from '@bike4mind/common';
import { invalidatePartnerRuleCache } from '@bike4mind/server-utils/entitlements/partnerRules';

/**
 * Drops the references that outlive a deleted organization. Partner signup rules keep their
 * entitlements and credits and lose only the organization, so no future signup resolves to a deleted
 * one. Domain claims are deleted so a verified domain is free for another org to claim. Integration
 * requests are the members' own votes and stay. Pending organization invites are closed.
 * Run after the delete commits. The integration-request and invite steps are best-effort: the org is
 * already gone, so a failure there must not turn the committed delete into an error a retry cannot fix.
 */
export async function clearDeletedOrganizationReferences(
  organizationId: string,
  logger: { warn: (message: string) => void }
): Promise<void> {
  await partnerSignupRuleRepository.updateMany({ organizationId }, { organizationId: null });
  invalidatePartnerRuleCache();
  await orgDomainClaimRepository.deleteByOrganization(organizationId);
  try {
    await integrationRequestRepository.clearOrganization(organizationId);
  } catch (err) {
    logger.warn(
      `Failed to clear integration requests' organization for deleted organization ${organizationId}: ${String(err)}`
    );
  }
  try {
    const invites = await inviteRepository.find({ type: InviteType.Organization, documentId: organizationId });
    for (const invite of invites) await inviteRepository.closeInvite(String(invite.id));
  } catch (err) {
    logger.warn(`Failed to close invites for deleted organization ${organizationId}: ${String(err)}`);
  }
}

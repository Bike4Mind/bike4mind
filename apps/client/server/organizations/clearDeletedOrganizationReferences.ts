import { integrationRequestRepository, partnerSignupRuleRepository } from '@bike4mind/database';
import { invalidatePartnerRuleCache } from '@bike4mind/server-utils/entitlements/partnerRules';

/**
 * Drops the references that outlive a deleted organization. Partner signup rules keep their
 * entitlements and credits and lose only the organization, so no future signup resolves to a deleted
 * one. Integration requests are the members' own votes and stay. Run after the delete commits.
 * The integration-request step is best-effort: the org is already gone, so a failure there must not
 * turn the committed delete into an error a retry cannot fix.
 */
export async function clearDeletedOrganizationReferences(
  organizationId: string,
  logger: { warn: (message: string) => void }
): Promise<void> {
  await partnerSignupRuleRepository.updateMany({ organizationId }, { organizationId: null });
  invalidatePartnerRuleCache();
  try {
    await integrationRequestRepository.clearOrganization(organizationId);
  } catch (err) {
    logger.warn(
      `Failed to clear integration requests' organization for deleted organization ${organizationId}: ${String(err)}`
    );
  }
}

import type { IOrganizationDocument } from '@bike4mind/common';
import type { ToolContext } from './types';

/** Resolve the turn's payer; a missing organization must never become a personal charge. */
export async function resolveToolBillingOrganization(context: ToolContext): Promise<IOrganizationDocument | null> {
  if (!context.organizationId) return null;
  const organization = await context.db.organizations?.findById(context.organizationId);
  if (!organization) throw new Error(`Billing organization ${context.organizationId} could not be resolved`);
  return organization;
}

import { IUserDocument, isOrgServiceAccountOf, orgServiceAccountEmail } from '@bike4mind/common';

interface OrgServiceAccountAdapters {
  db: {
    users: {
      findByEmail: (email: string) => Promise<IUserDocument | null>;
      findOrCreateByEmail: (email: string, defaults: Partial<IUserDocument>) => Promise<IUserDocument>;
    };
  };
}

/**
 * The organization's service account (see common constants/orgServiceAccount.ts), created on first use.
 * Created by upsert on its `.invalid` address, which skips the signup side effects (welcome email,
 * Stripe customer) a human account gets. Never added to the org's roster.
 */
export const getOrCreateOrgServiceAccount = async (
  organization: { id: string; name?: string },
  adapters: OrgServiceAccountAdapters
): Promise<IUserDocument> => {
  const user = await adapters.db.users.findOrCreateByEmail(orgServiceAccountEmail(organization.id), {
    name: `${organization.name || 'Organization'} service account`,
    username: `org-${organization.id}-service-account`,
    isSystem: true,
    isAdmin: false,
    serviceAccountOrganizationId: organization.id,
  });
  // The address is unroutable, so no human can hold it; refuse anyway rather than mint into a
  // record that is not this org's service account.
  if (!isOrgServiceAccountOf(user, organization.id)) {
    throw new Error(
      `Account at the service-account address of organization ${organization.id} is not its service account`
    );
  }
  return user;
};

/** The organization's service account, or null when it has never been created. */
export const findOrgServiceAccount = async (
  organizationId: string,
  adapters: { db: { users: Pick<OrgServiceAccountAdapters['db']['users'], 'findByEmail'> } }
): Promise<IUserDocument | null> => {
  const user = await adapters.db.users.findByEmail(orgServiceAccountEmail(organizationId));
  return isOrgServiceAccountOf(user, organizationId) ? user : null;
};

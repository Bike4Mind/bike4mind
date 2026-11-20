import { FC } from 'react';
import { IOrganizationDocument, WithId } from '@bike4mind/common';
import { OrganizationGroupsList } from '../organizations/OrganizationGroupsList';
import { SectionCard } from './shared';

/**
 * Platform-admin card to assign/unassign members of an org's provisioned groups (org-groups #1172,
 * issue #1417). Sits directly under OrganizationGroupTypesCard in the Admin -> Organizations panel
 * so an admin can grant a type and populate it without leaving the admin surface. The assign/
 * unassign endpoints already authorize platform admins, so no backend change is involved.
 *
 * Personal orgs cannot be granted group types, so they have no groups to populate - the sibling
 * types card already explains that, so this card renders nothing rather than repeat the notice.
 */
const OrganizationGroupMembersCard: FC<{ org: WithId<IOrganizationDocument> }> = ({ org }) => {
  if (org.personal) return null;

  return (
    <SectionCard title="Group members" body="custom" data-testid="org-group-members-card">
      {/*
        Override the empty-state copy: the shared default tells the reader to contact a Bike4Mind
        administrator, but here the reader IS one and the Group Types card that grants them is
        directly above. This is also the first-visit state for any org without types.
      */}
      <div style={{ padding: 16 }}>
        <OrganizationGroupsList
          organization={org}
          emptyStateMessage="No group types have been granted to this organization yet. Grant one in the Group Types card above to provision a group."
        />
      </div>
    </SectionCard>
  );
};

export default OrganizationGroupMembersCard;

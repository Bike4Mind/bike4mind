import { FC } from 'react';
import { Card } from '@mui/joy';
import { IOrganizationDocument, WithId } from '@bike4mind/common';
import { OrganizationGroupsList } from '../organizations/OrganizationGroupsList';

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
    <Card variant="outlined" sx={{ p: 2, mt: 2 }} data-testid="org-group-members-card">
      <OrganizationGroupsList organization={org} />
    </Card>
  );
};

export default OrganizationGroupMembersCard;

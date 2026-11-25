import React from 'react';
import { Link } from '@tanstack/react-router';
import { Typography } from '@mui/joy';
import { useAdminOrgServiceAccountId } from '@client/app/hooks/data/organizations';
import { Fact, SectionCard } from './shared';

/** Where an org's API keys are managed: they belong to its service account, whose profile has the Keys tab. */
const OrganizationApiKeysCard: React.FC<{ orgId: string }> = ({ orgId }) => {
  const account = useAdminOrgServiceAccountId(orgId);

  const value = account.isError ? (
    'API keys could not be loaded.'
  ) : account.isPending ? (
    'Loading'
  ) : account.data ? (
    <Link
      to="/admin/users/$userId"
      params={{ userId: account.data }}
      search={{ tab: 'keys' }}
      data-testid="org-api-keys-link"
      style={{ textDecoration: 'none' }}
    >
      <Typography level="body-sm" sx={{ color: 'admin.link' }}>
        Manage API keys
      </Typography>
    </Link>
  ) : (
    'No API keys have been created for this organization.'
  );

  return (
    <SectionCard title="API keys" data-testid="org-api-keys-card">
      <Fact label="Organization keys">{value}</Fact>
    </SectionCard>
  );
};

export default OrganizationApiKeysCard;

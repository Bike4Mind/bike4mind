import React from 'react';
import { Box, Chip, Link, Stack, Typography } from '@mui/joy';
import type { TutorialOwner } from '@bike4mind/common';
import { CORE_TUTORIALS_API_BASE } from '@client/app/components/tutorial/TutorialHostContext';
import TutorialDraftsCard from '@client/app/components/tutorial/admin/TutorialDraftsCard';
import TutorialModulesCard from '@client/app/components/tutorial/admin/TutorialModulesCard';
import { CORE_TUTORIAL_STEPS } from '@client/app/components/tutorial/core/coreTutorialSteps';
import TutorialsSwitchCard from '@client/app/components/tutorial/admin/TutorialsSwitchCard';
import { AdminPageHeader, EmptyState, ErrorState, LoadingState, SectionCard } from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import { useTutorialOwners, useTutorialOwnerSummary } from '@client/app/hooks/tutorials/useTutorialOwners';

const CORE_OWNER = 'core';

export const TutorialOwnerSection: React.FC<{ owner: TutorialOwner }> = ({ owner }) => {
  const summary = useTutorialOwnerSummary(owner.adminBase);

  return (
    <SectionCard
      title={owner.label}
      body="custom"
      data-testid={`tutorials-owner-${owner.owner}`}
      action={
        <Link href={owner.adminHref} data-testid={`tutorials-owner-link-${owner.owner}`}>
          Edit in {owner.label}
        </Link>
      }
    >
      <>
        {summary.isLoading ? (
          <LoadingState label={`Loading ${owner.label} tutorials`} />
        ) : summary.isError ? (
          <ErrorState
            message={`Could not load ${owner.label} tutorials.`}
            onRetry={() => void summary.refetch()}
            retrying={summary.isFetching}
          />
        ) : (summary.data ?? []).length === 0 ? (
          <EmptyState title={`${owner.label} has no tutorials yet`} action={null} />
        ) : (
          <Stack gap={0.5} sx={{ p: 2 }}>
            {(summary.data ?? []).map(row => (
              <Box
                key={row.id}
                data-testid={`tutorials-owner-row-${owner.owner}-${row.id}`}
                sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}
              >
                <Typography level="title-sm">{row.title}</Typography>
                <Chip size="sm" variant="soft" color={row.enabled ? 'success' : 'neutral'}>
                  {row.enabled ? 'on' : 'off'}
                </Chip>
              </Box>
            ))}
          </Stack>
        )}
      </>
    </SectionCard>
  );
};

/** Core's own tutorials with their cards, then each contributing owner's tutorials with a link to where they are edited. */
export const TutorialsTab: React.FC = () => {
  const owners = useTutorialOwners();

  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="tutorials-tab">
      <AdminPageHeader
        title="Tutorials"
        description="Turn tutorials on, edit core modules and drafts, and see what other owners contribute."
      />
      <Stack gap={1.5} data-testid="tutorials-core-section">
        <Typography level="title-lg">Core</Typography>
        <TutorialsSwitchCard apiBase={CORE_TUTORIALS_API_BASE} />
        <TutorialModulesCard apiBase={CORE_TUTORIALS_API_BASE} owner={CORE_OWNER} steps={CORE_TUTORIAL_STEPS} />
        <TutorialDraftsCard apiBase={CORE_TUTORIALS_API_BASE} owner={CORE_OWNER} />
      </Stack>
      {owners.isLoading ? (
        <LoadingState label="Loading other tutorial owners" />
      ) : owners.isError ? (
        <ErrorState
          message="Could not load the other tutorial owners."
          onRetry={() => void owners.refetch()}
          retrying={owners.isFetching}
        />
      ) : (
        (owners.data ?? []).map(owner => <TutorialOwnerSection key={owner.owner} owner={owner} />)
      )}
    </Stack>
  );
};

export default TutorialsTab;

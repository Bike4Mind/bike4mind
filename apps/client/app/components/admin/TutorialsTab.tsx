import React from 'react';
import { Box, Button, Chip, CircularProgress, Link, Stack, Typography } from '@mui/joy';
import type { TutorialOwner } from '@bike4mind/common';
import { CORE_TUTORIALS_API_BASE } from '@client/app/components/tutorial/TutorialHostContext';
import TutorialDraftsCard from '@client/app/components/tutorial/admin/TutorialDraftsCard';
import TutorialModulesCard from '@client/app/components/tutorial/admin/TutorialModulesCard';
import TutorialsSwitchCard from '@client/app/components/tutorial/admin/TutorialsSwitchCard';
import { SectionCard } from './shared';
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
      <Box sx={{ p: 2 }}>
        {summary.isLoading ? (
          <CircularProgress size="sm" />
        ) : summary.isError ? (
          <Stack direction="row" gap={1} alignItems="center" data-testid={`tutorials-owner-error-${owner.owner}`}>
            <Typography level="body-sm" color="danger">
              Could not load
            </Typography>
            <Button
              size="sm"
              variant="outlined"
              loading={summary.isFetching}
              onClick={() => void summary.refetch()}
              data-testid={`tutorials-owner-retry-${owner.owner}`}
            >
              Retry
            </Button>
          </Stack>
        ) : (summary.data ?? []).length === 0 ? (
          <Typography
            level="body-sm"
            sx={{ color: 'text.tertiary' }}
            data-testid={`tutorials-owner-empty-${owner.owner}`}
          >
            No tutorials.
          </Typography>
        ) : (
          <Stack gap={0.5}>
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
      </Box>
    </SectionCard>
  );
};

/** Core's own tutorials with their cards, then each contributing owner's tutorials with a link to where they are edited. */
export const TutorialsTab: React.FC = () => {
  const owners = useTutorialOwners();

  return (
    <Stack gap={3} data-testid="tutorials-tab">
      <Stack gap={1.5} data-testid="tutorials-core-section">
        <Typography level="title-lg">Core</Typography>
        <TutorialsSwitchCard apiBase={CORE_TUTORIALS_API_BASE} />
        <TutorialModulesCard apiBase={CORE_TUTORIALS_API_BASE} owner={CORE_OWNER} />
        <TutorialDraftsCard apiBase={CORE_TUTORIALS_API_BASE} owner={CORE_OWNER} />
      </Stack>
      {owners.isLoading ? (
        <CircularProgress size="sm" />
      ) : owners.isError ? (
        <Stack direction="row" gap={1} alignItems="center" data-testid="tutorials-owners-error">
          <Typography level="body-sm" color="danger">
            Could not load
          </Typography>
          <Button
            size="sm"
            variant="outlined"
            onClick={() => void owners.refetch()}
            data-testid="tutorials-owners-retry"
          >
            Retry
          </Button>
        </Stack>
      ) : (
        (owners.data ?? []).map(owner => <TutorialOwnerSection key={owner.owner} owner={owner} />)
      )}
    </Stack>
  );
};

export default TutorialsTab;

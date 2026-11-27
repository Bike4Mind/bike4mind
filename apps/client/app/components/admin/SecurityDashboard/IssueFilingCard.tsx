import { useState } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import { useSecopsTriageStatus } from '@client/app/hooks/data/admin';
import type { SecopsTriageStatusResponse } from '@client/pages/api/admin/secops-triage/status';
import { ErrorState, Fact, LoadingState, SectionCard, StatusChip } from '../shared';
import { REPO_ISSUE_LABELS } from './issueFiling';
import { IssueFilingSettingsDialog } from './IssueFilingSettingsDialog';

const TEST_ID = 'security-issue-filing';

function ConnectionChip({ github }: { github: SecopsTriageStatusResponse['github'] }) {
  const testId = `${TEST_ID}-connection-chip`;
  if (github.connected) return <StatusChip tone="good" label="Connected" data-testid={testId} />;
  if (github.checkError) return <StatusChip tone="neutral" label="Could not be checked" data-testid={testId} />;
  return <StatusChip tone="bad" label="Not connected" data-testid={testId} />;
}

function RepoChip({ github }: { github: SecopsTriageStatusResponse['github'] }) {
  const testId = `${TEST_ID}-repo-chip`;
  if (github.check?.ok) return <StatusChip tone="good" label="Ready" data-testid={testId} />;
  if (github.check) {
    const tone = github.check.reason === 'not_configured' ? 'neutral' : 'bad';
    return <StatusChip tone={tone} label={REPO_ISSUE_LABELS[github.check.reason]} data-testid={testId} />;
  }
  return <StatusChip tone="neutral" label={github.repo ? 'Could not be checked' : 'Not set'} data-testid={testId} />;
}

/** "High and above, up to 20 issues per scan". */
export const filingScope = (status: Pick<SecopsTriageStatusResponse, 'severityThreshold' | 'maxIssuesPerScan'>) =>
  `${status.severityThreshold === 'critical' ? 'Critical only' : 'High and above'}, up to ${status.maxIssuesPerScan} issue${status.maxIssuesPerScan === 1 ? '' : 's'} per scan`;

/**
 * Whether scan findings can reach GitHub issues with the saved settings, and the way into those
 * settings. Reads the status endpoint, so it never reflects an unsaved edit.
 */
export function IssueFilingCard() {
  const { data, isLoading, isError, isFetching, refetch } = useSecopsTriageStatus();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const action = (
    <Button
      variant="plain"
      color="neutral"
      size="sm"
      onClick={() => setSettingsOpen(true)}
      data-testid={`${TEST_ID}-settings-btn`}
    >
      Edit settings
    </Button>
  );

  return (
    <>
      {data ? (
        <SectionCard title="Issue filing" action={action} data-testid={TEST_ID}>
          <Fact label="GitHub connection" data-testid={`${TEST_ID}-connection`}>
            <ConnectionChip github={data.github} />
          </Fact>
          <Fact label="Repository" data-testid={`${TEST_ID}-repo`}>
            <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
              <RepoChip github={data.github} />
              {data.github.repo && (
                <Typography level="body-sm" component="span" sx={{ fontFamily: 'code', color: 'admin.inkMuted' }}>
                  {data.github.repo}
                </Typography>
              )}
            </Stack>
          </Fact>
          <Fact label="Filing" data-testid={`${TEST_ID}-filing`}>
            <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
              <StatusChip
                tone={data.enabled ? 'good' : 'neutral'}
                label={data.enabled ? 'On' : 'Off'}
                data-testid={`${TEST_ID}-filing-chip`}
              />
              {data.dryRun && <StatusChip tone="warn" label="Dry run" data-testid={`${TEST_ID}-dry-run-chip`} />}
              <Typography level="body-sm" component="span" sx={{ color: 'admin.inkMuted' }}>
                {filingScope(data)}
              </Typography>
            </Stack>
          </Fact>
        </SectionCard>
      ) : (
        <SectionCard title="Issue filing" action={action} body="custom" data-testid={TEST_ID}>
          {isLoading || !isError ? (
            <LoadingState label="Loading issue filing status" testId={`${TEST_ID}-loading`} />
          ) : (
            <ErrorState
              message="Issue filing status could not be loaded."
              onRetry={() => void refetch()}
              retrying={isFetching}
            />
          )}
        </SectionCard>
      )}
      {settingsOpen && <IssueFilingSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

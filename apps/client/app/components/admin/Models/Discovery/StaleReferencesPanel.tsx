import { useState } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/joy';
import {
  AdminPermissionAction,
  DataTable,
  ErrorState,
  LoadingState,
  SectionCard,
  StatusChip,
  type DataColumn,
} from '../../shared';
import { apiErrorMessage, useStaleReferences, type StaleReference } from './discoveryApi';
import { problemCopy } from './discoveryCopy';
import { modelName, useModelIndex } from './useModelIndex';

const referenceId = (reference: StaleReference) => `${reference.surface}|${reference.key}|${reference.referencedId}`;

/**
 * References to unavailable models (docs/admin-models-spec.md section 5.3): model ids that fallback chains and
 * defaults point at. Its own panel, not on model pages, because an unknown id has no model to sit on. Building the
 * report asks every provider, so nothing loads it until "Check references".
 */
export function StaleReferencesPanel() {
  const [requested, setRequested] = useState(false);
  const report = useStaleReferences();
  const index = useModelIndex().data?.byId;

  const check = () => {
    setRequested(true);
    void report.refetch();
  };

  const columns: DataColumn<StaleReference>[] = [
    { id: 'surface', label: 'Where', width: '12rem', render: reference => reference.surface },
    { id: 'entry', label: 'Entry', render: reference => modelName(index, reference.key) },
    {
      id: 'target',
      label: 'Points at',
      render: reference => (
        <Stack sx={{ minWidth: 0 }}>
          <Typography level="body-sm" noWrap>
            {modelName(index, reference.referencedId)}
          </Typography>
          {modelName(index, reference.referencedId) !== reference.referencedId && (
            <Typography level="body-xs" fontFamily="code" noWrap sx={{ color: 'admin.inkMuted' }}>
              {reference.referencedId}
            </Typography>
          )}
        </Stack>
      ),
    },
    {
      id: 'problem',
      label: 'Problem',
      width: '10rem',
      render: reference => {
        const copy = problemCopy(reference.problem);
        return <StatusChip tone={copy.tone} label={copy.label} />;
      },
    },
  ];

  const references = report.data?.staleReferences;
  const body = !requested ? (
    <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="discovery-references-idle">
      Finds fallback chains and defaults that point at a deprecated, retired or unknown model. Check references asks
      every provider again and shows the result.
    </Typography>
  ) : report.isFetching ? (
    <LoadingState label="Checking references" testId="discovery-references-loading" />
  ) : report.isError && !report.data ? (
    <ErrorState
      message={apiErrorMessage(report.error, 'Could not check references')}
      onRetry={check}
      retrying={report.isFetching}
    />
  ) : references === null || references === undefined ? (
    <Typography level="body-sm" sx={{ color: 'admin.danger' }} data-testid="discovery-references-error">
      {report.data?.staleReferencesError ?? 'The reference report is unavailable.'}
    </Typography>
  ) : references.length === 0 ? (
    <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="discovery-references-none">
      Every reference points at an available model.
    </Typography>
  ) : (
    <DataTable
      label="References to unavailable models"
      testId="discovery-references-table"
      rows={references}
      columns={columns}
      getRowId={referenceId}
      onRetry={check}
      rowTestId={reference => `discovery-reference-row-${reference.surface}-${reference.referencedId}`}
      pagination={references.length > 25 ? undefined : false}
    />
  );

  return (
    <SectionCard
      title="References to unavailable models"
      body="custom"
      data-testid="discovery-references"
      action={
        <AdminPermissionAction requirement="settings:manage">
          {disabled => (
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              disabled={disabled || (requested && report.isFetching)}
              onClick={check}
              data-testid="discovery-check-references-btn"
            >
              Check references
            </Button>
          )}
        </AdminPermissionAction>
      }
    >
      <Stack gap={1} sx={{ px: 2, py: 1.75 }}>
        {requested && !report.isFetching && report.isError && report.data && (
          <Alert color="warning" variant="soft" size="sm" data-testid="discovery-references-refresh-error">
            Showing the last check; checking again failed: {apiErrorMessage(report.error, 'Could not check references')}
          </Alert>
        )}
        {body}
      </Stack>
    </SectionCard>
  );
}

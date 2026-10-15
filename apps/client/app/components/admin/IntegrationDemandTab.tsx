import React, { useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Sheet, Stack, Table, Typography } from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { toast } from 'sonner';
import type { IntegrationDemand, IntegrationStage } from '@bike4mind/common';
import {
  fetchAllRequesterEmails,
  useIntegrationDemand,
  useIntegrationRequesters,
} from '@client/app/hooks/data/integrationDemand';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();

const STAGE_CHIP: Record<IntegrationStage, { label: string; color: 'neutral' | 'warning' | 'success' }> = {
  planned: { label: 'Roadmap', color: 'neutral' },
  beta: { label: 'Beta', color: 'warning' },
  ga: { label: 'Live', color: 'success' },
};

const StageChip: React.FC<{ stage: IntegrationStage | null }> = ({ stage }) =>
  stage ? (
    <Chip size="sm" variant="soft" color={STAGE_CHIP[stage].color}>
      {STAGE_CHIP[stage].label}
    </Chip>
  ) : (
    <Chip size="sm" variant="outlined" color="neutral">
      Not in catalog
    </Chip>
  );

const RequestersPanel: React.FC<{ integration: IntegrationDemand }> = ({ integration }) => {
  const { integrationId, name } = integration;
  const requesters = useIntegrationRequesters(integrationId);
  const [copying, setCopying] = useState(false);
  const rows = requesters.data?.pages.flatMap(page => page.data) ?? [];

  const copyEmails = async () => {
    setCopying(true);
    try {
      const emails = await fetchAllRequesterEmails(integrationId);
      if (emails.length === 0) {
        toast.info('None of these requesters has an email on file.');
        return;
      }
      await navigator.clipboard.writeText(emails.join(', '));
      toast.success(`Copied ${emails.length} email${emails.length === 1 ? '' : 's'}`);
    } catch {
      toast.error("Couldn't copy the emails. Try again.");
    } finally {
      setCopying(false);
    }
  };

  return (
    <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'sm' }} data-testid="admin-integration-demand-requesters">
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2} sx={{ mb: 1 }}>
        <Typography level="title-md">Who requested {name}</Typography>
        <Button
          size="sm"
          variant="outlined"
          startDecorator={<ContentCopyIcon />}
          loading={copying}
          onClick={() => void copyEmails()}
          data-testid="admin-integration-demand-copy-emails-btn"
        >
          Copy emails
        </Button>
      </Stack>

      {requesters.error ? (
        <Alert color="danger" data-testid="admin-integration-demand-requesters-error">
          Couldn&apos;t load the requesters.
        </Alert>
      ) : requesters.isPending ? (
        <CircularProgress size="sm" />
      ) : (
        <>
          <Table size="sm" data-testid="admin-integration-demand-requesters-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Organization</th>
                <th>Requested</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.userId} data-testid={`admin-integration-demand-requester-${row.userId}`}>
                  <td>{row.name ?? 'Deleted account'}</td>
                  <td>{row.email ?? '-'}</td>
                  <td>{row.organizationName ?? (row.organizationId ? 'Deleted organization' : '-')}</td>
                  <td>{formatDate(row.requestedAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {requesters.hasNextPage ? (
            <Button
              size="sm"
              variant="plain"
              loading={requesters.isFetchingNextPage}
              onClick={() => void requesters.fetchNextPage()}
              sx={{ mt: 1 }}
              data-testid="admin-integration-demand-load-more-btn"
            >
              Load more
            </Button>
          ) : null}
        </>
      )}
    </Sheet>
  );
};

/**
 * Roadmap demand from the Integrations page: totals per integration, and for the selected one,
 * who asked. Reads the admin demand API, which an admin-scoped API key can call too.
 */
export const IntegrationDemandTab: React.FC = () => {
  const demand = useIntegrationDemand();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const integrations = demand.data?.integrations ?? [];
  const selected = integrations.find(row => row.integrationId === selectedId) ?? null;

  return (
    <Stack spacing={2} data-testid="admin-integration-demand-tab">
      <Box>
        <Typography level="h4">Integration demand</Typography>
        <Typography level="body-sm" textColor="text.secondary">
          Requests filed from the roadmap cards on the Integrations page, most requested first. An integration that has
          left the roadmap keeps its history and shows its current stage. Select a row to see who asked.
        </Typography>
      </Box>

      {demand.error ? (
        <Alert color="danger" data-testid="admin-integration-demand-error">
          Couldn&apos;t load integration demand.
        </Alert>
      ) : demand.isPending ? (
        <CircularProgress size="sm" />
      ) : integrations.length === 0 ? (
        <Alert color="neutral" data-testid="admin-integration-demand-empty">
          No integration requests yet.
        </Alert>
      ) : (
        <Table size="sm" hoverRow data-testid="admin-integration-demand-table">
          <thead>
            <tr>
              <th>Integration</th>
              <th>Stage</th>
              <th>Requests</th>
              <th>Organizations</th>
              <th>First request</th>
              <th>Latest request</th>
            </tr>
          </thead>
          <tbody>
            {integrations.map(row => {
              const isSelected = row.integrationId === selectedId;
              return (
                <tr
                  key={row.integrationId}
                  tabIndex={0}
                  aria-selected={isSelected}
                  onClick={() => setSelectedId(row.integrationId)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedId(row.integrationId);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                  data-testid={`admin-integration-demand-row-${row.integrationId}`}
                >
                  <td>
                    <Typography level="body-sm" fontWeight={isSelected ? 'lg' : undefined}>
                      {row.name}
                    </Typography>
                  </td>
                  <td>
                    <StageChip stage={row.stage} />
                  </td>
                  <td>{row.total}</td>
                  <td>{row.organizations}</td>
                  <td>{formatDate(row.firstRequestedAt)}</td>
                  <td>{formatDate(row.latestRequestedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {selected ? <RequestersPanel key={selected.integrationId} integration={selected} /> : null}
    </Stack>
  );
};

export default IntegrationDemandTab;

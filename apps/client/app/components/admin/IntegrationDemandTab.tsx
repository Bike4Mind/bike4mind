import { INTEGRATION_DEMAND_SEARCH_KEYS } from './integrationDemandSearch';
import React, { useState } from 'react';
import { Alert, Button, CircularProgress, Sheet, Stack, Table, Typography } from '@mui/joy';
import {
  AdminPageHeader,
  DataTable,
  EmptyState,
  FilterBar,
  SavedViews,
  StatStrip,
  StatTile,
  StatusChip,
  useAdminListUrlState,
  type DataColumn,
} from './shared';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { toast } from 'sonner';
import type { IntegrationDemand, IntegrationStage } from '@bike4mind/common';
import {
  REQUESTER_EMAILS_MAX_ROWS,
  fetchAllRequesterEmails,
  isRateLimited,
  useIntegrationDemand,
  useIntegrationRequesters,
  type RequesterEmails,
} from '@client/app/hooks/data/integrationDemand';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();

const RATE_LIMITED_MESSAGE = 'Too many requests, try again in a minute';

type EmailLookup = { ok: true; found: RequesterEmails } | { ok: false; error: unknown };

/**
 * Put the emails on the clipboard. Safari only honours a clipboard write started inside the click
 * itself, so where ClipboardItem exists the write starts at once with the emails still being
 * fetched (ClipboardItem accepts a promise for its blob); elsewhere the fetch finishes first.
 * The lookup settles on its own, so the caller reads its outcome whatever the write did.
 */
async function copyRequesterEmails(lookup: Promise<EmailLookup>): Promise<boolean> {
  const text = async () => {
    const result = await lookup;
    if (!result.ok || result.found.emails.length === 0) throw new Error('Nothing to copy');
    return result.found.emails.join(', ');
  };
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const blob = text().then(joined => new Blob([joined], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    } else {
      await navigator.clipboard.writeText(await text());
    }
    return true;
  } catch {
    return false;
  }
}

const STAGE_CHIP: Record<IntegrationStage, { label: string; tone: 'neutral' | 'warn' | 'good' }> = {
  planned: { label: 'Roadmap', tone: 'neutral' },
  beta: { label: 'Beta', tone: 'warn' },
  ga: { label: 'Live', tone: 'good' },
};

// Sort by lifecycle, with integrations missing from the catalog first.
const STAGE_RANK: Record<IntegrationStage, number> = { planned: 1, beta: 2, ga: 3 };

const StageChip: React.FC<{ stage: IntegrationStage | null }> = ({ stage }) => (
  <StatusChip
    tone={stage ? STAGE_CHIP[stage].tone : 'neutral'}
    label={stage ? STAGE_CHIP[stage].label : 'Not in catalog'}
  />
);

const DEMAND_COLUMNS: readonly DataColumn<IntegrationDemand>[] = [
  { id: 'name', label: 'Integration', render: row => row.name, sortValue: row => row.name },
  {
    id: 'stage',
    label: 'Stage',
    render: row => <StageChip stage={row.stage} />,
    sortValue: row => (row.stage ? STAGE_RANK[row.stage] : 0),
  },
  {
    id: 'total',
    label: 'Requests',
    render: row => row.total.toLocaleString(),
    sortValue: row => row.total,
    numeric: true,
  },
  {
    id: 'organizations',
    label: 'Organizations',
    render: row => row.organizations.toLocaleString(),
    sortValue: row => row.organizations,
    numeric: true,
  },
  {
    id: 'first',
    label: 'First request',
    render: row => formatDate(row.firstRequestedAt),
    sortValue: row => row.firstRequestedAt,
  },
  {
    id: 'latest',
    label: 'Latest request',
    render: row => formatDate(row.latestRequestedAt),
    sortValue: row => row.latestRequestedAt,
  },
];

const RequestersPanel: React.FC<{ integration: IntegrationDemand }> = ({ integration }) => {
  const { integrationId, name } = integration;
  const requesters = useIntegrationRequesters(integrationId);
  const [copying, setCopying] = useState(false);
  const rows = requesters.data?.pages.flatMap(page => page.data) ?? [];

  // Not awaited before the clipboard write starts: see copyRequesterEmails.
  const copyEmails = async () => {
    setCopying(true);
    const lookup: Promise<EmailLookup> = fetchAllRequesterEmails(integrationId).then(
      found => ({ ok: true, found }),
      error => ({ ok: false, error })
    );
    const copied = await copyRequesterEmails(lookup);
    const result = await lookup;
    setCopying(false);
    if (!result.ok) {
      toast.error(isRateLimited(result.error) ? RATE_LIMITED_MESSAGE : "Couldn't copy the emails. Try again.");
      return;
    }
    const { emails, truncated } = result.found;
    if (emails.length === 0) {
      toast.info('None of these requesters has an email on file.');
    } else if (!copied) {
      toast.error("Couldn't copy the emails. Try again.");
    } else if (truncated) {
      toast.warning(
        `Copied ${emails.length} emails, but this list is longer than ${REQUESTER_EMAILS_MAX_ROWS.toLocaleString()} requesters and the rest are missing.`,
        { duration: 10_000 }
      );
    } else {
      toast.success(`Copied ${emails.length} email${emails.length === 1 ? '' : 's'}`);
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
          {isRateLimited(requesters.error) ? RATE_LIMITED_MESSAGE : "Couldn't load the requesters."}
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
                  <td>{row.deleted ? 'Deleted account' : (row.name ?? '-')}</td>
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
  const [view, updateView] = useAdminListUrlState(INTEGRATION_DEMAND_SEARCH_KEYS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const integrations = demand.data?.integrations ?? [];
  const visibleIntegrations = integrations.filter(
    row =>
      row.name.toLowerCase().includes(view.query.toLowerCase()) &&
      (!view.filters.stage || row.stage === view.filters.stage)
  );
  const selected = visibleIntegrations.find(row => row.integrationId === selectedId) ?? null;

  return (
    <Stack
      spacing={2}
      sx={{ bgcolor: 'admin.canvas', color: 'admin.ink', p: 2, borderRadius: 'md' }}
      data-testid="admin-integration-demand-tab"
    >
      <AdminPageHeader
        title="Integration demand"
        count={integrations.length}
        description="Requests filed from the roadmap cards on the Integrations page, most requested first. Select a row to see who asked."
      />
      <StatStrip>
        <StatTile label="Integrations requested" value={integrations.length} />
        <StatTile label="Requests" value={integrations.reduce((total, row) => total + row.total, 0)} />
        <StatTile label="Live integrations" value={integrations.filter(row => row.stage === 'ga').length} />
      </StatStrip>
      <SavedViews
        state={view}
        onChange={updateView}
        views={[
          { id: 'all', label: 'All demand', filters: {} },
          { id: 'roadmap', label: 'Roadmap', filters: { stage: 'planned' } },
          { id: 'live', label: 'Live', filters: { stage: 'ga' } },
        ]}
      />
      <FilterBar
        state={view}
        onChange={updateView}
        searchLabel="Search integrations"
        filters={[
          {
            id: 'stage',
            label: 'Stage',
            options: [
              { value: 'planned', label: 'Roadmap' },
              { value: 'beta', label: 'Beta' },
              { value: 'ga', label: 'Live' },
            ],
          },
        ]}
      />
      <div
        data-testid={
          demand.error
            ? 'admin-integration-demand-error'
            : !demand.isPending && integrations.length === 0
              ? 'admin-integration-demand-empty'
              : undefined
        }
      >
        <DataTable
          rows={visibleIntegrations}
          pageResetKey={JSON.stringify([view.query, view.filters])}
          columns={DEMAND_COLUMNS}
          label="Integration demand"
          getRowId={row => row.integrationId}
          testId="admin-integration-demand-table"
          rowTestId={row => `admin-integration-demand-row-${row.integrationId}`}
          loading={demand.isPending}
          error={demand.error ? "Couldn't load integration demand." : undefined}
          onRetry={() => void demand.refetch()}
          onRowActivate={row => setSelectedId(row.integrationId)}
          activeRowId={selectedId ?? undefined}
          empty={
            <EmptyState
              title={integrations.length ? 'No matching integrations' : 'No integration requests yet.'}
              action={
                <Button
                  variant="outlined"
                  data-testid="admin-demand-reset-btn"
                  onClick={() => {
                    updateView({ query: '', filters: {}, view: '' });
                    void demand.refetch();
                  }}
                >
                  {integrations.length ? 'Clear filters' : 'Refresh demand'}
                </Button>
              }
            />
          }
        />
      </div>

      {selected ? <RequestersPanel key={selected.integrationId} integration={selected} /> : null}
    </Stack>
  );
};

export default IntegrationDemandTab;

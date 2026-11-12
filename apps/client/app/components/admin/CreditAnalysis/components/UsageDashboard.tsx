import React, { useMemo, useState } from 'react';
import { Alert, Autocomplete, Box, Button, Chip, Stack, Typography } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import { CreditHolderType, UNCLASSIFIED_SOURCE, type UsageOwnerType } from '@bike4mind/common';
import { useSearchOrganizations } from '@client/app/hooks/data/organizations';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { formatCredits, formatUsd } from '../utils/format';
import { AdminPageHeader, DataTable, EmptyState, ErrorState, FilterBar, LoadingState } from '../../shared';
import { useOwnerUsage } from '../hooks/useOwnerUsage';
import { zeroFillDailySeries } from '../utils/dailySeries';
import { DailyAreaChart } from './DailyAreaChart';
import { BreakdownTable } from '@client/app/components/common/BreakdownTable';
import { usageFeatureLabel } from '../utils/usageFeatureLabels';

const DAY_RANGES = [30, 60, 90] as const;
type DayRange = (typeof DAY_RANGES)[number];

type OrgOption = { id: string; name: string };

/**
 * One owner's AI spend: a credits burn chart over the selected window plus
 * model / feature / API key / source breakdowns (and, for organizations, a
 * by-member cut). Serves personal (User) and Organization owners through one
 * code path - see GET /api/usage.
 *
 * `ownerType` selects the owner kind. `ownerId` pins the owner; when omitted for
 * an Organization owner an admin org picker is shown (cross-org admin surface).
 * A User owner is always pinned to `ownerId` (no picker).
 *
 * `days` lets a parent that already owns a range toggle (the profile ledger) drive the window; the
 * panel then hides its own toggle.
 *
 * `reconcileLedger` makes the totals follow the credit ledger, adding an "Other charges" row for spend
 * with no usage event. Only the profile page sets it, because it shows the ledger beside this panel and
 * the two must agree. Org views have no ledger section, and the ledger's generic_deduct rows include
 * non-spend debits (expiry, clawbacks, admin adjustments) for any owner.
 */
export const UsageDashboard: React.FC<{
  ownerType: UsageOwnerType;
  ownerId?: string;
  days?: number;
  reconcileLedger?: boolean;
}> = ({ ownerType, ownerId, days: controlledDays, reconcileLedger = false }) => {
  const isOrg = ownerType === CreditHolderType.Organization;
  const showOrgPicker = isOrg && !ownerId;

  const [selectedOrg, setSelectedOrg] = useState<OrgOption | null>(null);
  const [ownDays, setDays] = useState<DayRange>(30);
  const days = controlledDays ?? ownDays;

  const activeOwnerId = ownerId ?? (showOrgPicker ? (selectedOrg?.id ?? null) : null);

  // Debounce so typing a name fires one request per pause, not one per keystroke.
  const { debouncedValue: orgSearch, setValue: setOrgSearch } = useDebounceValue('', 500);

  // Team orgs only: personal orgs are single-user and not the point of an org dashboard.
  // Skipped entirely unless the admin org picker is shown.
  const {
    data: orgResult,
    isLoading: orgsLoading,
    isError: orgsError,
    isFetching: orgsFetching,
    refetch: refetchOrganizations,
  } = useSearchOrganizations(
    {
      page: 1,
      limit: 20,
      search: orgSearch,
      filters: { personal: false },
      orderBy: { by: 'name', direction: 'asc' },
    },
    { enabled: showOrgPicker }
  );

  const orgOptions: OrgOption[] = useMemo(
    () => (orgResult?.data ?? []).map(o => ({ id: String(o.id), name: o.name })),
    [orgResult]
  );

  const { data, isLoading, isFetching, error, refetch } = useOwnerUsage(ownerType, activeOwnerId, days);

  const eventCredits = data?.totals.creditsCharged ?? 0;
  // The ledger is what the owner was charged; events miss charges written without a per-call record.
  const ledgerCredits = reconcileLedger ? (data?.ledger?.creditsCharged ?? eventCredits) : eventCredits;
  const residualCredits = ledgerCredits - eventCredits;
  const hasResidual = residualCredits > 0;
  const hasEvents = (data?.totals.requests ?? 0) > 0;
  const hasUsage = hasEvents || hasResidual;
  // The posted ledger remains authoritative even when per-call records exceed it.
  const totalCredits = ledgerCredits;
  const detailExceedsLedger = reconcileLedger && eventCredits > ledgerCredits;
  const chartData = useMemo(() => zeroFillDailySeries(data?.overTime ?? [], days, d => d.creditsCharged), [data, days]);

  return (
    <Stack gap={2} data-testid="usage-dashboard">
      <AdminPageHeader
        level="section"
        title={isOrg ? 'Organization usage' : 'Personal usage'}
        description={
          isOrg ? "Spend billed to this organization's credit pool." : 'Spend billed to your personal credit pool.'
        }
        actions={
          <Button
            variant="plain"
            startDecorator={<RefreshIcon />}
            onClick={() => void refetch()}
            disabled={!activeOwnerId || isFetching}
            data-testid="usage-refresh-btn"
          >
            Refresh usage
          </Button>
        }
      />
      {showOrgPicker && orgsError && (
        <ErrorState
          message="Organizations could not be loaded."
          onRetry={() => void refetchOrganizations()}
          retrying={orgsFetching}
        />
      )}
      {showOrgPicker ? (
        <Autocomplete
          placeholder="Select an organization"
          options={orgOptions}
          getOptionLabel={o => o.name}
          isOptionEqualToValue={(o, v) => o.id === v.id}
          value={selectedOrg}
          onChange={(_, value) => setSelectedOrg(value)}
          onInputChange={(_, value) => setOrgSearch(value)}
          loading={orgsLoading}
          sx={{ minWidth: 260 }}
          data-testid="usage-org-select"
        />
      ) : null}
      {controlledDays === undefined && (
        <FilterBar
          search={false}
          state={{ query: '', view: '', filters: { days: String(days) } }}
          filters={[
            {
              id: 'days',
              label: 'Window',
              options: DAY_RANGES.map(value => ({ value: String(value), label: `${value} days` })),
            },
          ]}
          onChange={patch => {
            if (patch.filters?.days) setDays(Number(patch.filters.days) as DayRange);
          }}
        />
      )}

      <Alert color="neutral" size="sm" sx={{ mb: 2 }}>
        {isOrg
          ? "Spend billed to this organization's credit pool (owner-scoped). Members are the users who ran each call; feature is the product surface (chat, agent, operations, embedding). Per-call detail comes from usage events recorded since deploy."
          : "Spend billed to your personal credit pool (owner-scoped). Feature is the product surface (chat, agent, operations, embedding); keys billed to an organization appear in that org's dashboard instead. Per-call detail comes from usage events recorded since deploy." +
            (reconcileLedger ? ' Charges with no such record appear as Other charges.' : '')}
      </Alert>

      {!activeOwnerId ? (
        <EmptyState
          title={showOrgPicker ? 'Select an organization to see its spend' : 'No usage to show'}
          action={null}
        />
      ) : error ? (
        <ErrorState
          message={error instanceof Error ? error.message : 'Failed to load usage'}
          onRetry={() => void refetch()}
        />
      ) : isLoading || !data ? (
        <LoadingState label="Loading usage" />
      ) : (
        <Stack spacing={3}>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip color="primary" variant="soft" data-testid="usage-total-credits">
              {formatCredits(totalCredits)} credits
            </Chip>
            <Chip color="neutral" variant="soft" data-testid="usage-total-cogs">
              {formatUsd(data?.totals.cogsUsd ?? 0)} COGS
            </Chip>
            <Chip color="neutral" variant="soft" data-testid="usage-total-requests">
              {(data?.totals.requests ?? 0).toLocaleString()} requests
            </Chip>
          </Stack>

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Credits over time
            </Typography>
            {!hasUsage ? (
              <Typography level="body-sm" color="neutral">
                No usage in this window.
              </Typography>
            ) : !hasEvents ? (
              <Typography level="body-sm" color="neutral" data-testid="usage-no-events-note">
                The charges in this window have no per-call record, so there is no daily chart.
              </Typography>
            ) : (
              <DailyAreaChart
                data={chartData}
                valueLabel="Credits"
                formatValue={formatCredits}
                color="primary"
                height={260}
              />
            )}
            {hasResidual && hasEvents && (
              <Typography level="body-xs" color="neutral" data-testid="usage-chart-detail-note">
                Chart covers charges with a per-call record only.
              </Typography>
            )}
          </Box>

          {detailExceedsLedger && (
            <Typography level="body-xs" color="neutral" data-testid="usage-ledger-detail-note">
              Per-call records total {formatCredits(eventCredits)} credits, above the posted ledger total of{' '}
              {formatCredits(ledgerCredits)} credits. The chart and per-call breakdown show those records; the headline
              shows the posted ledger.
            </Typography>
          )}

          {isOrg && (
            <BreakdownTable
              title="By member"
              testid="usage-member-table"
              keyLabel="Member"
              rows={(data?.byMember ?? []).map(r => ({
                key: r.userId,
                label: r.userName ?? 'Unknown user',
                title: r.userId,
                requests: r.requests,
                cogsUsd: r.cogsUsd,
                creditsCharged: r.creditsCharged,
              }))}
            />
          )}

          <BreakdownTable
            title="By model"
            testid="usage-model-table"
            keyLabel="Model"
            emptyText={hasResidual ? "No per-call detail for this window's charges." : undefined}
            rows={(data?.byModel ?? []).map(r => ({
              key: `${r.provider}-${r.model}`,
              label: `${r.provider} / ${r.model}`,
              requests: r.requests,
              cogsUsd: r.cogsUsd,
              creditsCharged: r.creditsCharged,
            }))}
          />

          <BreakdownTable
            title="By feature"
            testid="usage-feature-table"
            keyLabel="Feature"
            rows={[
              ...(data?.byFeature ?? []).map(r => ({
                key: r.feature,
                label: usageFeatureLabel(r.feature),
                requests: r.requests,
                cogsUsd: r.cogsUsd,
                creditsCharged: r.creditsCharged,
              })),
              ...(hasResidual
                ? [
                    {
                      key: 'other-charges',
                      label: 'Other charges (no per-call detail)',
                      requests: 0,
                      cogsUsd: 0,
                      creditsCharged: residualCredits,
                    },
                  ]
                : []),
            ]}
          />
          {hasResidual && (
            <Typography level="body-xs" color="neutral" sx={{ mt: -2 }} data-testid="usage-residual-note">
              Other charges are on your credit ledger but have no per-call record, so they carry no model, request count
              or COGS.
            </Typography>
          )}

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              By API key
            </Typography>
            <Typography level="body-xs" color="neutral" sx={{ mb: 1 }}>
              {isOrg
                ? 'API-token spend billed to this org (from the ledger; no COGS on API-key rows).'
                : 'API-token spend billed to you (from the ledger; no COGS on API-key rows).'}
            </Typography>
            <DataTable
              label="By API key"
              testId="usage-apikey-table"
              rows={data.byApiKey}
              getRowId={row => row.apiKeyId}
              pagination={false}
              maxHeight="320px"
              onRetry={() => void refetch()}
              empty={<EmptyState title="No API-token usage in this window" action={null} />}
              columns={[
                {
                  id: 'key',
                  label: 'API key',
                  render: row => <span title={row.keyPrefix ?? row.apiKeyId}>{row.keyName ?? 'Unknown key'}</span>,
                },
                { id: 'requests', label: 'Requests', numeric: true, render: row => row.requests.toLocaleString() },
                { id: 'input', label: 'Input tokens', numeric: true, render: row => row.inputTokens.toLocaleString() },
                {
                  id: 'output',
                  label: 'Output tokens',
                  numeric: true,
                  render: row => row.outputTokens.toLocaleString(),
                },
                { id: 'credits', label: 'Credits', numeric: true, render: row => formatCredits(row.creditsSpent) },
              ]}
            />
          </Box>

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              By source
            </Typography>
            <Typography level="body-xs" color="neutral" sx={{ mb: 1 }}>
              {isOrg
                ? 'Where this org\'s spend originated (from the ledger; credits only, no COGS). "Unclassified" is usage with no source recorded on the ledger row.'
                : 'Where your spend originated (from the ledger; credits only, no COGS). "Unclassified" is usage with no source recorded on the ledger row.'}
              {hasResidual && ' Metered AI usage only; other charges are not attributed to a source.'}
            </Typography>
            <DataTable
              label="By source"
              testId="usage-source-table"
              rows={data.bySource}
              getRowId={row => row.source}
              pagination={false}
              maxHeight="320px"
              onRetry={() => void refetch()}
              empty={
                <EmptyState
                  title={hasResidual ? 'No metered AI usage in this window.' : 'No usage in this window.'}
                  action={null}
                />
              }
              columns={[
                {
                  id: 'source',
                  label: 'Source',
                  render: row => (row.source === UNCLASSIFIED_SOURCE ? 'Unclassified' : row.source),
                },
                { id: 'requests', label: 'Requests', numeric: true, render: row => row.requests.toLocaleString() },
                { id: 'credits', label: 'Credits', numeric: true, render: row => formatCredits(row.creditsSpent) },
              ]}
            />
          </Box>
        </Stack>
      )}
    </Stack>
  );
};

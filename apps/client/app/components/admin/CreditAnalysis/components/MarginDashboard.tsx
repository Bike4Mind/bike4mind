import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Stack,
  Textarea,
  Typography,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import { api } from '@client/app/contexts/ApiContext';
import {
  getPriceMargin,
  IFundingCohortCost,
  IModelDayMargin,
  IProviderInvoice,
  IProviderMonthCogs,
  ISettlementBreakdown,
  IUserMargin,
} from '@bike4mind/common';
import { ReconciliationBanner } from './ReconciliationBanner';
import {
  AdminDialog,
  AdminPageHeader,
  AdminSearchInput,
  DataTable,
  EmptyState,
  ErrorState,
  FilterToolbar,
  LoadingState,
} from '../../shared';

interface MarginResponse<T> {
  targetCreditsPerUsd: number;
  rows: T[];
}

/** API resolves the id to a display name. */
type NamedUserMargin = IUserMargin & { userName?: string };

/**
 * Credits charged per $1 of COGS vs the current-pricing target, banded:
 * green within +/-2% of target (stochastic-rounding noise), yellow from
 * there down to break-even (target / markup) or up to +20% (older pricing,
 * mild drift), red below break-even (losing money) or above +20%.
 */
const RatioChip: React.FC<{ credits: number; cogsUsd: number; target: number }> = ({ credits, cogsUsd, target }) => {
  if (cogsUsd <= 0 || target <= 0) {
    return (
      <Chip size="sm" color="neutral" data-testid="margin-ratio-chip">
        n/a
      </Chip>
    );
  }
  const ratio = credits / cogsUsd;
  const breakEven = target / getPriceMargin();
  const rel = ratio / target;
  const color = rel >= 0.98 && rel <= 1.02 ? 'success' : ratio >= breakEven && rel <= 1.2 ? 'warning' : 'danger';
  return (
    <Chip size="sm" color={color} data-testid="margin-ratio-chip">
      {Math.round(ratio).toLocaleString()} cr/$
    </Chip>
  );
};

// The server error envelope puts the human-readable reason in data.error
// (see server/middlewares/errorHandler.ts); data.message and err.message
// stay as fallbacks for endpoints that don't follow that envelope.
const apiErrorMessage = (err: unknown, fallback: string) => {
  const e = err as { response?: { data?: { error?: string; message?: string } }; message?: string };
  return e.response?.data?.error || e.response?.data?.message || e.message || fallback;
};

/** Reconciliation status vs the entered invoice, as % of invoice. */
const invoiceStatus = (
  invoiceUsd: number,
  cogsUsd: number
): { label: string; color: 'success' | 'warning' | 'danger' } => {
  const pct = invoiceUsd > 0 ? (Math.abs(invoiceUsd - cogsUsd) / invoiceUsd) * 100 : 100;
  if (pct < 2) return { label: 'match', color: 'success' };
  if (pct <= 10) return { label: 'review', color: 'warning' };
  return { label: 'gap', color: 'danger' };
};

const formatCohortWeek = (cohortWeek: Date | string | null) =>
  cohortWeek === null ? 'Unknown' : new Date(cohortWeek).toISOString().slice(0, 10);

const formatUsd = (value: number) => `$${value.toFixed(2)}`;

const grantedShare = (costUsd: IFundingCohortCost['costUsd']) => {
  const attributed = costUsd.granted + costUsd.purchased + costUsd.subscription + costUsd.unknown;
  return attributed > 0 ? `${Math.round((costUsd.granted / attributed) * 100)}%` : '-';
};

const signedUsd = (value: number) => `${value < 0 ? '-' : '+'}$${Math.abs(value).toFixed(2)}`;

export const MarginDashboard: React.FC = () => {
  const [modelDay, setModelDay] = useState<MarginResponse<IModelDayMargin> | null>(null);
  const [byUser, setByUser] = useState<MarginResponse<NamedUserMargin> | null>(null);
  const [byProvider, setByProvider] = useState<MarginResponse<IProviderMonthCogs> | null>(null);
  const [settlement, setSettlement] = useState<MarginResponse<ISettlementBreakdown> | null>(null);
  const [fundingCohort, setFundingCohort] = useState<MarginResponse<IFundingCohortCost> | null>(null);
  const [fundingCohortError, setFundingCohortError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<IProviderInvoice[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('');

  // Entry modal state; target null = closed.
  const [entryTarget, setEntryTarget] = useState<{ month: string; provider: string } | null>(null);
  const [entryUsd, setEntryUsd] = useState('');
  const [entryNote, setEntryNote] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Fetched apart from the other views: its aggregation joins users, and a failure there must
  // not blank the margin sections that loaded fine.
  const fetchFundingCohort = useCallback(async () => {
    setFundingCohortError(null);
    try {
      const res = await api.get<MarginResponse<IFundingCohortCost>>(
        '/api/admin/usage-margin?view=funding-cohort&days=30'
      );
      setFundingCohort(res.data);
    } catch (err) {
      setFundingCohortError(apiErrorMessage(err, 'Failed to load cost by funding source'));
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const fundingCohortRequest = fetchFundingCohort();
    try {
      const [modelDayRes, userRes, providerRes, settlementRes, invoicesRes] = await Promise.all([
        api.get<MarginResponse<IModelDayMargin>>('/api/admin/usage-margin?view=model-day&days=30'),
        api.get<MarginResponse<NamedUserMargin>>('/api/admin/usage-margin?view=user&days=30'),
        api.get<MarginResponse<IProviderMonthCogs>>('/api/admin/usage-margin?view=provider-month'),
        api.get<MarginResponse<ISettlementBreakdown>>('/api/admin/usage-margin?view=settlement&days=30'),
        api.get<{ invoices: IProviderInvoice[] }>('/api/admin/provider-invoices'),
      ]);
      setModelDay(modelDayRes.data);
      setByUser(userRes.data);
      setByProvider(providerRes.data);
      setSettlement(settlementRes.data);
      setInvoices(invoicesRes.data.invoices);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to load margin data');
    } finally {
      await fundingCohortRequest;
      setIsLoading(false);
    }
  }, [fetchFundingCohort]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const target = modelDay?.targetCreditsPerUsd ?? 0;
  const providerNeedle = providerFilter.trim().toLowerCase();
  const userNeedle = userSearch.trim().toLowerCase();
  const modelDayRows = (modelDay?.rows ?? []).filter(
    r =>
      !providerNeedle ||
      r.provider.toLowerCase().includes(providerNeedle) ||
      (r.executedProvider ?? '').toLowerCase().includes(providerNeedle)
  );
  const userRows = (byUser?.rows ?? []).filter(
    r =>
      !userNeedle ||
      (r.userName ?? '').toLowerCase().includes(userNeedle) ||
      r.userId.toLowerCase().includes(userNeedle)
  );
  const providerMonthRows = (byProvider?.rows ?? []).filter(
    r => !providerNeedle || r.provider.toLowerCase().includes(providerNeedle)
  );
  const currentMonth = new Date().toISOString().slice(0, 7);
  const invoiceFor = (month: string, provider: string) =>
    invoices.find(i => i.month === month && i.provider === provider);

  const openEntry = (month: string, provider: string, existing?: IProviderInvoice) => {
    setEntryTarget({ month, provider });
    setEntryUsd(existing ? String(existing.invoiceUsd) : '');
    setEntryNote('');
    setEntryError(null);
  };

  const entryAmount = Number.parseFloat(entryUsd);
  const entryValid = Number.isFinite(entryAmount) && entryAmount >= 0 && entryNote.trim().length > 0;

  const saveEntry = async () => {
    if (!entryTarget || !entryValid) return;
    setIsSaving(true);
    setEntryError(null);
    try {
      await api.post('/api/admin/provider-invoices', {
        month: entryTarget.month,
        provider: entryTarget.provider,
        invoiceUsd: entryAmount,
        note: entryNote.trim(),
      });
      setEntryTarget(null);
      await fetchAll();
    } catch (err) {
      setEntryError(apiErrorMessage(err, 'Failed to save invoice'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Box sx={{ p: { xs: 1, sm: 2 } }} data-testid="margin-dashboard">
      <ReconciliationBanner />
      <Stack gap={2} sx={{ mb: 2, mt: 1 }}>
        <AdminPageHeader
          level="section"
          title="Margins (last 30 days)"
          actions={
            <>
              {target > 0 && (
                <Chip size="sm" color="primary" variant="soft" data-testid="margin-target-chip">
                  target: {target.toLocaleString()} credits/$
                </Chip>
              )}
              <IconButton
                size="sm"
                onClick={() => void fetchAll()}
                disabled={isLoading}
                data-testid="margin-refresh-btn"
                aria-label="Refresh margins"
              >
                <RefreshIcon />
              </IconButton>
            </>
          }
        />
        <FilterToolbar data-testid="margin-filter-toolbar">
          <AdminSearchInput
            label="Filter provider"
            value={providerFilter}
            onChange={setProviderFilter}
            data-testid="margin-provider-filter"
          />
          <AdminSearchInput
            label="Search user"
            value={userSearch}
            onChange={setUserSearch}
            data-testid="margin-user-search"
          />
        </FilterToolbar>
      </Stack>

      <Alert color="neutral" size="sm" sx={{ mb: 2 }}>
        Data comes from usage events (dual-written since deploy); requests before that are not included. The target is
        what current pricing charges per $1 of provider cost. Green chips are within 2% of it, yellow chips are between
        break-even and +20% (typically older pricing), and red chips are below break-even or more than 20% above target.
      </Alert>

      {error && !entryTarget ? (
        <ErrorState message={error} onRetry={() => void fetchAll()} />
      ) : isLoading && !modelDay ? (
        <LoadingState label="Loading margins" />
      ) : (
        <Stack spacing={3}>
          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              By model by day
            </Typography>
            <DataTable
              label="By model by day"
              testId="margin-model-day-table"
              rows={modelDayRows}
              getRowId={row =>
                `${row.day}-${row.provider}-${row.model}-${row.executedProvider ?? row.provider}-${row.executedModel ?? row.model}`
              }
              onRetry={() => void fetchAll()}
              pagination={false}
              minWidth="64rem"
              maxHeight="320px"
              empty={<EmptyState title="No usage events yet" action={null} />}
              columns={[
                { id: 'day', label: 'Day', render: row => row.day },
                { id: 'provider', label: 'Provider', render: row => row.provider },
                { id: 'model', label: 'Model', render: row => row.model },
                {
                  id: 'executed',
                  label: 'Executed model',
                  render: row => (
                    <span data-testid="margin-executed-model-cell">
                      {row.executedProvider &&
                      (row.executedProvider !== row.provider || row.executedModel !== row.model)
                        ? `${row.executedProvider} / ${row.executedModel ?? row.model}`
                        : row.executedModel && row.executedModel !== row.model
                          ? `${row.provider} / ${row.executedModel}`
                          : '-'}
                    </span>
                  ),
                },
                { id: 'requests', label: 'Requests', numeric: true, render: row => row.requests.toLocaleString() },
                { id: 'cogs', label: 'COGS (USD)', numeric: true, render: row => `$${row.cogsUsd.toFixed(4)}` },
                { id: 'credits', label: 'Credits', numeric: true, render: row => row.creditsCharged.toLocaleString() },
                {
                  id: 'margin',
                  label: 'Margin',
                  render: row => <RatioChip credits={row.creditsCharged} cogsUsd={row.cogsUsd} target={target} />,
                },
              ]}
            />
          </Box>

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              By user (worst margin first)
            </Typography>
            <DataTable
              label="By user"
              testId="margin-user-table"
              rows={userRows}
              getRowId={row => row.userId}
              onRetry={() => void fetchAll()}
              pagination={false}
              maxHeight="320px"
              empty={<EmptyState title="No usage events yet" action={null} />}
              columns={[
                {
                  id: 'user',
                  label: 'User',
                  render: row => <span title={row.userId}>{row.userName ?? row.userId}</span>,
                },
                { id: 'requests', label: 'Requests', numeric: true, render: row => row.requests.toLocaleString() },
                { id: 'cogs', label: 'COGS (USD)', numeric: true, render: row => `$${row.cogsUsd.toFixed(4)}` },
                { id: 'credits', label: 'Credits', numeric: true, render: row => row.creditsCharged.toLocaleString() },
                {
                  id: 'margin',
                  label: 'Margin',
                  render: row => <RatioChip credits={row.creditsCharged} cogsUsd={row.cogsUsd} target={target} />,
                },
              ]}
            />
          </Box>

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Monthly COGS by provider (invoice reconciliation)
            </Typography>
            <DataTable
              label="Monthly COGS by provider"
              testId="margin-provider-month-table"
              rows={providerMonthRows}
              getRowId={row => `${row.month}-${row.provider}`}
              onRetry={() => void fetchAll()}
              pagination={false}
              minWidth="88rem"
              maxHeight="320px"
              empty={<EmptyState title="No usage events yet" action={null} />}
              columns={[
                { id: 'month', label: 'Month', render: row => row.month },
                { id: 'provider', label: 'Provider', render: row => row.provider },
                { id: 'requests', label: 'Requests', numeric: true, render: row => row.requests.toLocaleString() },
                { id: 'cogs', label: 'COGS (USD)', numeric: true, render: row => `$${row.cogsUsd.toFixed(2)}` },
                { id: 'input', label: 'Input tokens', numeric: true, render: row => row.inputTokens.toLocaleString() },
                {
                  id: 'output',
                  label: 'Output tokens',
                  numeric: true,
                  render: row => row.outputTokens.toLocaleString(),
                },
                {
                  id: 'cached',
                  label: 'Cached tokens',
                  numeric: true,
                  render: row => row.cachedInputTokens.toLocaleString(),
                },
                {
                  id: 'writes',
                  label: 'Cache writes',
                  numeric: true,
                  render: row => row.cacheWriteTokens.toLocaleString(),
                },
                {
                  id: 'invoice',
                  label: 'Invoice',
                  numeric: true,
                  render: row => {
                    const key = `${row.month}-${row.provider}`;
                    const invoice = invoiceFor(row.month, row.provider);
                    return (
                      <span data-testid={`margin-invoice-cell-${key}`}>
                        {invoice ? (
                          `$${invoice.invoiceUsd.toFixed(2)}`
                        ) : (
                          <Button
                            size="sm"
                            variant="plain"
                            disabled={row.month === currentMonth}
                            title={
                              row.month === currentMonth
                                ? 'Month still accruing; reconcile closed months only'
                                : undefined
                            }
                            onClick={() => openEntry(row.month, row.provider)}
                            data-testid={`margin-invoice-enter-${key}`}
                          >
                            Enter
                          </Button>
                        )}
                      </span>
                    );
                  },
                },
                {
                  id: 'delta',
                  label: 'Delta',
                  numeric: true,
                  render: row => (
                    <span data-testid={`margin-invoice-delta-${row.month}-${row.provider}`}>
                      {invoiceFor(row.month, row.provider)
                        ? signedUsd(invoiceFor(row.month, row.provider)!.invoiceUsd - row.cogsUsd)
                        : '-'}
                    </span>
                  ),
                },
                {
                  id: 'status',
                  label: 'Status',
                  render: row => {
                    const invoice = invoiceFor(row.month, row.provider);
                    const key = `${row.month}-${row.provider}`;
                    if (!invoice)
                      return (
                        <Chip size="sm" color="neutral" data-testid={`margin-invoice-chip-${key}`}>
                          no invoice
                        </Chip>
                      );
                    const status = invoiceStatus(invoice.invoiceUsd, row.cogsUsd);
                    return (
                      <Chip
                        size="sm"
                        color={status.color}
                        onClick={() => openEntry(row.month, row.provider, invoice)}
                        data-testid={`margin-invoice-chip-${key}`}
                      >
                        {status.label}
                      </Chip>
                    );
                  },
                },
              ]}
            />
          </Box>

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Settlement basis (last 30 days)
            </Typography>
            <Typography level="body-xs" sx={{ mb: 1 }} color="neutral">
              How usage was priced: provider-reported token counts vs the local estimate fallback. Token deltas are
              provider minus local, averaged over rows reporting both.
            </Typography>
            <DataTable
              label="Settlement basis"
              testId="margin-settlement-table"
              rows={settlement?.rows ?? []}
              getRowId={row => row.settledBasis}
              rowTestId={row => `margin-settlement-row-${row.settledBasis}`}
              onRetry={() => void fetchAll()}
              pagination={false}
              empty={<EmptyState title="No settled usage events in the window" action={null} />}
              columns={[
                { id: 'basis', label: 'Basis', render: row => row.settledBasis },
                { id: 'requests', label: 'Requests', numeric: true, render: row => row.requests.toLocaleString() },
                { id: 'credits', label: 'Credits', numeric: true, render: row => row.creditsCharged.toLocaleString() },
                {
                  id: 'written',
                  label: 'Written off',
                  numeric: true,
                  render: row => row.writtenOffCredits.toLocaleString(),
                },
                {
                  id: 'input',
                  label: 'Avg input token delta',
                  numeric: true,
                  render: row =>
                    row.deltaSampleSize > 0
                      ? Math.round(row.inputTokenDelta / row.deltaSampleSize).toLocaleString()
                      : 'n/a',
                },
                {
                  id: 'output',
                  label: 'Avg output token delta',
                  numeric: true,
                  render: row =>
                    row.deltaSampleSize > 0
                      ? Math.round(row.outputTokenDelta / row.deltaSampleSize).toLocaleString()
                      : 'n/a',
                },
                {
                  id: 'sample',
                  label: 'Delta sample',
                  numeric: true,
                  render: row => row.deltaSampleSize.toLocaleString(),
                },
              ]}
            />
          </Box>

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Cost by funding source (last 30 days)
            </Typography>
            <Typography level="body-xs" sx={{ mb: 1 }} color="neutral">
              Provider cost split by what funded the credits, grouped by the week each spender signed up. Unattributed
              is cost on zero-credit calls, on calls recorded before funding was stamped, and on calls whose funding
              lookup failed; granted share leaves it out.
            </Typography>
            {fundingCohortError ? (
              <ErrorState message={fundingCohortError} onRetry={() => void fetchFundingCohort()} />
            ) : (
              <DataTable
                label="Cost by funding source"
                testId="margin-funding-cohort-table"
                rows={fundingCohort?.rows ?? []}
                getRowId={row => formatCohortWeek(row.cohortWeek)}
                rowTestId={row => `margin-funding-cohort-row-${formatCohortWeek(row.cohortWeek)}`}
                onRetry={() => void fetchFundingCohort()}
                pagination={false}
                empty={<EmptyState title="No usage events yet" action={null} />}
                columns={[
                  { id: 'week', label: 'Signup week', render: row => formatCohortWeek(row.cohortWeek) },
                  { id: 'accounts', label: 'Accounts', numeric: true, render: row => row.accounts.toLocaleString() },
                  { id: 'granted', label: 'Granted $', numeric: true, render: row => formatUsd(row.costUsd.granted) },
                  {
                    id: 'purchased',
                    label: 'Purchased $',
                    numeric: true,
                    render: row => formatUsd(row.costUsd.purchased),
                  },
                  {
                    id: 'subscription',
                    label: 'Subscription $',
                    numeric: true,
                    render: row => formatUsd(row.costUsd.subscription),
                  },
                  { id: 'unknown', label: 'Unknown $', numeric: true, render: row => formatUsd(row.costUsd.unknown) },
                  {
                    id: 'unattributed',
                    label: 'Unattributed $',
                    numeric: true,
                    render: row => formatUsd(row.unattributedCostUsd),
                  },
                  {
                    id: 'share',
                    label: 'Granted share',
                    numeric: true,
                    render: row => (
                      <span data-testid={`margin-funding-cohort-share-${formatCohortWeek(row.cohortWeek)}`}>
                        {grantedShare(row.costUsd)}
                      </span>
                    ),
                  },
                ]}
              />
            )}
          </Box>
        </Stack>
      )}

      <AdminDialog
        open={entryTarget !== null}
        onClose={() => !isSaving && setEntryTarget(null)}
        title={`Invoice: ${entryTarget?.provider ?? ''} ${entryTarget?.month ?? ''}`}
        width={440}
        data-testid="margin-invoice-modal"
      >
        {entryError && (
          <Alert color="danger" size="sm" data-testid="margin-invoice-modal-error">
            {entryError}
          </Alert>
        )}
        <FormControl>
          <FormLabel>Invoice total (USD)</FormLabel>
          <Input
            type="number"
            value={entryUsd}
            onChange={e => setEntryUsd(e.target.value)}
            slotProps={{ input: { min: 0, step: 'any' } }}
            data-testid="margin-invoice-usd-input"
          />
        </FormControl>
        <FormControl>
          <FormLabel>Note (invoice id and billing period)</FormLabel>
          <Textarea
            minRows={2}
            value={entryNote}
            onChange={e => setEntryNote(e.target.value)}
            data-testid="margin-invoice-note-input"
          />
        </FormControl>
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button variant="plain" color="neutral" disabled={isSaving} onClick={() => setEntryTarget(null)}>
            Cancel
          </Button>
          <Button loading={isSaving} disabled={!entryValid} onClick={saveEntry} data-testid="margin-invoice-save-btn">
            Save
          </Button>
        </Stack>
      </AdminDialog>
    </Box>
  );
};

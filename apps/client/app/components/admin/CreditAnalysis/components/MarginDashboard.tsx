import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Modal,
  ModalDialog,
  Sheet,
  Stack,
  Table,
  Textarea,
  Typography,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import { api } from '@client/app/contexts/ApiContext';
import {
  getPriceMargin,
  IModelDayMargin,
  IProviderInvoice,
  IProviderMonthCogs,
  ISettlementBreakdown,
  IUserMargin,
} from '@bike4mind/common';

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

const numberCell = { fontVariantNumeric: 'tabular-nums' } as const;

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

const signedUsd = (value: number) => `${value < 0 ? '-' : '+'}$${Math.abs(value).toFixed(2)}`;

export const MarginDashboard: React.FC = () => {
  const [modelDay, setModelDay] = useState<MarginResponse<IModelDayMargin> | null>(null);
  const [byUser, setByUser] = useState<MarginResponse<NamedUserMargin> | null>(null);
  const [byProvider, setByProvider] = useState<MarginResponse<IProviderMonthCogs> | null>(null);
  const [settlement, setSettlement] = useState<MarginResponse<ISettlementBreakdown> | null>(null);
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

  const fetchAll = useCallback(async () => {
    setIsLoading(true);
    setError(null);
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
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const target = modelDay?.targetCreditsPerUsd ?? 0;
  const providerNeedle = providerFilter.trim().toLowerCase();
  const userNeedle = userSearch.trim().toLowerCase();
  const modelDayRows = (modelDay?.rows ?? []).filter(
    r => !providerNeedle || r.provider.toLowerCase().includes(providerNeedle)
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
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography level="title-md">Margins (last 30 days)</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <Input
            size="sm"
            placeholder="Filter provider"
            value={providerFilter}
            onChange={e => setProviderFilter(e.target.value)}
            data-testid="margin-provider-filter"
          />
          <Input
            size="sm"
            placeholder="Search user"
            value={userSearch}
            onChange={e => setUserSearch(e.target.value)}
            data-testid="margin-user-search"
          />
          {target > 0 && (
            <Chip size="sm" color="primary" variant="soft" data-testid="margin-target-chip">
              target: {target.toLocaleString()} credits/$
            </Chip>
          )}
          <IconButton size="sm" onClick={fetchAll} disabled={isLoading} data-testid="margin-refresh-btn">
            <RefreshIcon />
          </IconButton>
        </Stack>
      </Stack>

      <Alert color="neutral" size="sm" sx={{ mb: 2 }}>
        Data comes from usage events (dual-written since deploy); requests before that are not included. The target is
        what current pricing charges per $1 of provider cost. Green chips are within 2% of it, yellow chips are between
        break-even and +20% (typically older pricing), and red chips are below break-even or more than 20% above target.
      </Alert>

      {error && (
        <Alert color="danger" sx={{ mb: 2 }} data-testid="margin-error">
          {error}
        </Alert>
      )}

      {isLoading && !modelDay ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Stack spacing={3}>
          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              By model by day
            </Typography>
            <Sheet sx={{ maxHeight: 320, overflow: 'auto' }}>
              <Table stickyHeader hoverRow size="sm" data-testid="margin-model-day-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Provider</th>
                    <th>Model</th>
                    <th style={{ textAlign: 'right' }}>Requests</th>
                    <th style={{ textAlign: 'right' }}>COGS (USD)</th>
                    <th style={{ textAlign: 'right' }}>Credits</th>
                    <th>Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {modelDayRows.map(row => (
                    <tr key={`${row.day}-${row.provider}-${row.model}`}>
                      <td>{row.day}</td>
                      <td>{row.provider}</td>
                      <td>{row.model}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>{row.requests.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>${row.cogsUsd.toFixed(4)}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>{row.creditsCharged.toLocaleString()}</td>
                      <td>
                        <RatioChip credits={row.creditsCharged} cogsUsd={row.cogsUsd} target={target} />
                      </td>
                    </tr>
                  ))}
                  {modelDayRows.length === 0 && (
                    <tr>
                      <td colSpan={7}>
                        <Typography level="body-sm" color="neutral">
                          No usage events yet.
                        </Typography>
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </Sheet>
          </Box>

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              By user (worst margin first)
            </Typography>
            <Sheet sx={{ maxHeight: 320, overflow: 'auto' }}>
              <Table stickyHeader hoverRow size="sm" data-testid="margin-user-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th style={{ textAlign: 'right' }}>Requests</th>
                    <th style={{ textAlign: 'right' }}>COGS (USD)</th>
                    <th style={{ textAlign: 'right' }}>Credits</th>
                    <th>Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {userRows.map(row => (
                    <tr key={row.userId}>
                      <td title={row.userId}>{row.userName ?? row.userId}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>{row.requests.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>${row.cogsUsd.toFixed(4)}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>{row.creditsCharged.toLocaleString()}</td>
                      <td>
                        <RatioChip credits={row.creditsCharged} cogsUsd={row.cogsUsd} target={target} />
                      </td>
                    </tr>
                  ))}
                  {userRows.length === 0 && (
                    <tr>
                      <td colSpan={5}>
                        <Typography level="body-sm" color="neutral">
                          No usage events yet.
                        </Typography>
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </Sheet>
          </Box>

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Monthly COGS by provider (invoice reconciliation)
            </Typography>
            <Sheet sx={{ maxHeight: 320, overflow: 'auto' }}>
              <Table stickyHeader hoverRow size="sm" data-testid="margin-provider-month-table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Provider</th>
                    <th style={{ textAlign: 'right' }}>Requests</th>
                    <th style={{ textAlign: 'right' }}>COGS (USD)</th>
                    <th style={{ textAlign: 'right' }}>Input tokens</th>
                    <th style={{ textAlign: 'right' }}>Output tokens</th>
                    <th style={{ textAlign: 'right' }}>Cached tokens</th>
                    <th style={{ textAlign: 'right' }}>Cache writes</th>
                    <th style={{ textAlign: 'right' }}>Invoice</th>
                    <th style={{ textAlign: 'right' }}>Delta</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {providerMonthRows.map(row => {
                    const key = `${row.month}-${row.provider}`;
                    const invoice = invoiceFor(row.month, row.provider);
                    const isCurrent = row.month === currentMonth;
                    return (
                      <tr key={key}>
                        <td>{row.month}</td>
                        <td>{row.provider}</td>
                        <td style={{ textAlign: 'right', ...numberCell }}>{row.requests.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', ...numberCell }}>${row.cogsUsd.toFixed(2)}</td>
                        <td style={{ textAlign: 'right', ...numberCell }}>{row.inputTokens.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', ...numberCell }}>{row.outputTokens.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', ...numberCell }}>{row.cachedInputTokens.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', ...numberCell }}>{row.cacheWriteTokens.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', ...numberCell }} data-testid={`margin-invoice-cell-${key}`}>
                          {invoice ? (
                            `$${invoice.invoiceUsd.toFixed(2)}`
                          ) : (
                            <Button
                              size="sm"
                              variant="plain"
                              disabled={isCurrent}
                              title={isCurrent ? 'Month still accruing; reconcile closed months only' : undefined}
                              onClick={() => openEntry(row.month, row.provider)}
                              data-testid={`margin-invoice-enter-${key}`}
                            >
                              Enter
                            </Button>
                          )}
                        </td>
                        <td style={{ textAlign: 'right', ...numberCell }} data-testid={`margin-invoice-delta-${key}`}>
                          {invoice ? signedUsd(invoice.invoiceUsd - row.cogsUsd) : '-'}
                        </td>
                        <td>
                          {invoice ? (
                            (() => {
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
                            })()
                          ) : (
                            <Chip size="sm" color="neutral" data-testid={`margin-invoice-chip-${key}`}>
                              no invoice
                            </Chip>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {providerMonthRows.length === 0 && (
                    <tr>
                      <td colSpan={11}>
                        <Typography level="body-sm" color="neutral">
                          No usage events yet.
                        </Typography>
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </Sheet>
          </Box>

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Settlement basis (last 30 days)
            </Typography>
            <Typography level="body-xs" sx={{ mb: 1 }} color="neutral">
              How usage was priced: provider-reported token counts vs the local estimate fallback. Token deltas are
              provider minus local, averaged over rows reporting both.
            </Typography>
            <Sheet sx={{ overflow: 'auto' }}>
              <Table size="sm" data-testid="margin-settlement-table">
                <thead>
                  <tr>
                    <th>Basis</th>
                    <th style={{ textAlign: 'right' }}>Requests</th>
                    <th style={{ textAlign: 'right' }}>Credits</th>
                    <th style={{ textAlign: 'right' }}>Written off</th>
                    <th style={{ textAlign: 'right' }}>Avg input token delta</th>
                    <th style={{ textAlign: 'right' }}>Avg output token delta</th>
                    <th style={{ textAlign: 'right' }}>Delta sample</th>
                  </tr>
                </thead>
                <tbody>
                  {(settlement?.rows ?? []).map(row => {
                    const avg = (delta: number) =>
                      row.deltaSampleSize > 0 ? Math.round(delta / row.deltaSampleSize).toLocaleString() : 'n/a';
                    return (
                      <tr key={row.settledBasis} data-testid={`margin-settlement-row-${row.settledBasis}`}>
                        <td>{row.settledBasis}</td>
                        <td style={{ textAlign: 'right', ...numberCell }}>{row.requests.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', ...numberCell }}>{row.creditsCharged.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', ...numberCell }}>{row.writtenOffCredits.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', ...numberCell }}>{avg(row.inputTokenDelta)}</td>
                        <td style={{ textAlign: 'right', ...numberCell }}>{avg(row.outputTokenDelta)}</td>
                        <td style={{ textAlign: 'right', ...numberCell }}>{row.deltaSampleSize.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                  {(settlement?.rows ?? []).length === 0 && (
                    <tr>
                      <td colSpan={7}>
                        <Typography level="body-sm" color="neutral">
                          No settled usage events in the window.
                        </Typography>
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </Sheet>
          </Box>
        </Stack>
      )}

      <Modal open={entryTarget !== null} onClose={() => !isSaving && setEntryTarget(null)}>
        <ModalDialog data-testid="margin-invoice-modal" sx={{ minWidth: 360 }}>
          <Typography level="title-md">
            Invoice: {entryTarget?.provider} {entryTarget?.month}
          </Typography>
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
        </ModalDialog>
      </Modal>
    </Box>
  );
};

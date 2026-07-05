import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Chip, CircularProgress, IconButton, Sheet, Stack, Table, Typography } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import { api } from '@client/app/contexts/ApiContext';
import { IModelDayMargin, IProviderMonthCogs, IUserMargin } from '@bike4mind/common';

interface MarginResponse<T> {
  targetCreditsPerUsd: number;
  rows: T[];
}

/** API resolves the id to a display name. */
type NamedUserMargin = IUserMargin & { userName?: string };

/**
 * Credits charged per $1 of COGS vs the current-pricing target.
 * Rows below target were charged under older pricing or indicate a leak.
 */
const RatioChip: React.FC<{ credits: number; cogsUsd: number; target: number }> = ({ credits, cogsUsd, target }) => {
  if (cogsUsd <= 0) {
    return (
      <Chip size="sm" color="neutral" data-testid="margin-ratio-chip">
        n/a
      </Chip>
    );
  }
  const ratio = credits / cogsUsd;
  return (
    <Chip size="sm" color={ratio < target ? 'danger' : 'success'} data-testid="margin-ratio-chip">
      {Math.round(ratio).toLocaleString()} cr/$
    </Chip>
  );
};

const numberCell = { fontVariantNumeric: 'tabular-nums' } as const;

export const MarginDashboard: React.FC = () => {
  const [modelDay, setModelDay] = useState<MarginResponse<IModelDayMargin> | null>(null);
  const [byUser, setByUser] = useState<MarginResponse<NamedUserMargin> | null>(null);
  const [byProvider, setByProvider] = useState<MarginResponse<IProviderMonthCogs> | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [modelDayRes, userRes, providerRes] = await Promise.all([
        api.get<MarginResponse<IModelDayMargin>>('/api/admin/usage-margin?view=model-day&days=30'),
        api.get<MarginResponse<NamedUserMargin>>('/api/admin/usage-margin?view=user&days=30'),
        api.get<MarginResponse<IProviderMonthCogs>>('/api/admin/usage-margin?view=provider-month'),
      ]);
      setModelDay(modelDayRes.data);
      setByUser(userRes.data);
      setByProvider(providerRes.data);
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

  return (
    <Box sx={{ p: { xs: 1, sm: 2 } }} data-testid="margin-dashboard">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography level="title-md">Margins (last 30 days)</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
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
        what current pricing charges per $1 of provider cost. red rows recovered fewer credits than that.
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
                  {(modelDay?.rows ?? []).map(row => (
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
                  {(modelDay?.rows ?? []).length === 0 && (
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
                  {(byUser?.rows ?? []).map(row => (
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
                  {(byUser?.rows ?? []).length === 0 && (
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
                  </tr>
                </thead>
                <tbody>
                  {(byProvider?.rows ?? []).map(row => (
                    <tr key={`${row.month}-${row.provider}`}>
                      <td>{row.month}</td>
                      <td>{row.provider}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>{row.requests.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>${row.cogsUsd.toFixed(2)}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>{row.inputTokens.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>{row.outputTokens.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>{row.cachedInputTokens.toLocaleString()}</td>
                    </tr>
                  ))}
                  {(byProvider?.rows ?? []).length === 0 && (
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
        </Stack>
      )}
    </Box>
  );
};

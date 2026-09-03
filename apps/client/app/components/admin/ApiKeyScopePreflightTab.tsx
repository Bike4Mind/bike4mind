import React, { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Option,
  Select,
  Sheet,
  Stack,
  Table,
  Typography,
} from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import WarningIcon from '@mui/icons-material/Warning';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import { isAxiosError } from 'axios';
import { ApiKeyScope } from '@bike4mind/common';
import type { IApiKeyScopePreflightRow } from '@bike4mind/common';
import { useApiKeyScopePreflight, type ScopePreflightParams } from '@client/app/hooks/data/apiKeyScopePreflight';

const WINDOW_OPTIONS = [7, 30, 90];

/** ApiKeyUsageLog's TTL. Only a run at this window has seen the whole logged history. */
const FULL_WINDOW_DAYS = 90;

/**
 * The handler's refusals are the remedy, not the symptom: an unlogged prefix and
 * an unknown scope both explain themselves in the thrown message, which
 * `errorHandler` puts at `response.data.error`. Axios's own `.message` is the
 * generic "Request failed with status code 400", which turns an explained refusal
 * into what looks like a broken tool.
 */
const preflightErrorMessage = (error: unknown): string => {
  if (isAxiosError(error)) {
    return error.response?.data?.error || error.response?.data?.message || error.message;
  }
  return error instanceof Error ? error.message : 'Preflight failed';
};

/** Whether Run would re-ask the question already on screen, rather than a new one. */
const isSameRun = (a: ScopePreflightParams | null, b: ScopePreflightParams): boolean =>
  a !== null &&
  a.endpointPrefix === b.endpointPrefix &&
  a.days === b.days &&
  a.scopes.length === b.scopes.length &&
  a.scopes.every((scope, i) => scope === b.scopes[i]);

const OutcomeChip: React.FC<{ outcome: IApiKeyScopePreflightRow['outcome'] }> = ({ outcome }) => {
  const config = {
    deny: { color: 'danger' as const, icon: <ErrorIcon fontSize="small" />, label: 'would 403' },
    stagedAllow: { color: 'warning' as const, icon: <WarningIcon fontSize="small" />, label: 'staged only' },
    allow: { color: 'success' as const, icon: <CheckCircleIcon fontSize="small" />, label: 'passes' },
  }[outcome];
  return (
    <Chip size="sm" color={config.color} startDecorator={config.icon} variant="soft">
      {config.label}
    </Chip>
  );
};

/**
 * Scope-enforcement preflight: before declaring `requiredScopes` on routes that
 * currently have none, find every key already calling them that would be
 * rejected. See the route handler for why this beats reading the staged-allow
 * log line.
 */
export const ApiKeyScopePreflightTab: React.FC = () => {
  const [endpointPrefix, setEndpointPrefix] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [days, setDays] = useState(90);
  const [submitted, setSubmitted] = useState<ScopePreflightParams | null>(null);

  const { data, isFetching, error, refetch } = useApiKeyScopePreflight(submitted);

  const scopeOptions = useMemo(() => Object.values(ApiKeyScope), []);
  const canRun = endpointPrefix.trim().startsWith('/') && selectedScopes.length > 0;

  const counts = useMemo(() => {
    const rows = data?.rows ?? [];
    return {
      deny: rows.filter(r => r.outcome === 'deny').length,
      stagedAllow: rows.filter(r => r.outcome === 'stagedAllow').length,
      allow: rows.filter(r => r.outcome === 'allow').length,
    };
  }, [data]);

  return (
    <Stack spacing={2} data-testid="admin-scope-preflight-tab">
      <Box>
        <Typography level="h4">API key scope preflight</Typography>
        <Typography level="body-sm" textColor="text.secondary">
          Before declaring <code>requiredScopes</code> on routes that currently have none, check which live keys would
          start getting 403s. A key holds only the scopes it was minted with, so they must be re-minted before the gate
          enforces. Reads {data?.windowDays ?? 90} days of API-key usage history.
        </Typography>
      </Box>

      <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'sm' }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'flex-end' }}>
          <FormControl sx={{ flex: 2 }}>
            <FormLabel>Endpoint prefix</FormLabel>
            <Input
              placeholder="/api/some/prefix"
              value={endpointPrefix}
              onChange={e => setEndpointPrefix(e.target.value)}
              data-testid="scope-preflight-prefix-input"
            />
            <FormHelperText>
              Matched as a plain string prefix, not by path segment, so <code>/api/chat</code> also matches{' '}
              <code>/api/chatbots</code>.
            </FormHelperText>
          </FormControl>

          <FormControl sx={{ flex: 2 }}>
            <FormLabel>Scopes the routes would require (any one passes)</FormLabel>
            <Select
              multiple
              value={selectedScopes}
              onChange={(_, value) => setSelectedScopes(value as string[])}
              data-testid="scope-preflight-scopes-select"
            >
              {scopeOptions.map(scope => (
                <Option key={scope} value={scope}>
                  {scope}
                </Option>
              ))}
            </Select>
          </FormControl>

          <FormControl sx={{ flex: 1 }}>
            <FormLabel>Window</FormLabel>
            <Select value={days} onChange={(_, value) => setDays((value as number) ?? 90)}>
              {WINDOW_OPTIONS.map(option => (
                <Option key={option} value={option}>
                  {option} days
                </Option>
              ))}
            </Select>
          </FormControl>

          <Button
            startDecorator={<SearchIcon />}
            disabled={!canRun || isFetching}
            onClick={() => {
              const next = { endpointPrefix: endpointPrefix.trim(), scopes: selectedScopes, days };
              // Identical params hash to the same react-query key, so the mounted
              // observer serves cache and fires nothing - no request, and no
              // `isFetching` either, so a stale answer is indistinguishable from a
              // fresh one. Run must always mean run.
              if (isSameRun(submitted, next)) {
                void refetch();
                return;
              }
              setSubmitted(next);
            }}
            data-testid="scope-preflight-run-btn"
          >
            Run
          </Button>
        </Stack>
      </Sheet>

      {error ? (
        <Alert color="danger" data-testid="scope-preflight-error">
          {preflightErrorMessage(error)}
        </Alert>
      ) : null}

      {isFetching ? (
        <Stack direction="row" spacing={1} alignItems="center">
          <CircularProgress size="sm" />
          <Typography level="body-sm">Scanning usage history...</Typography>
        </Stack>
      ) : null}

      {data && !isFetching ? (
        <Stack spacing={2}>
          {/*
            The form stays editable while these results stay on screen, so without
            an echo of the run that produced them a verdict can be read as
            answering a prefix nobody ran. The server echoes both fields back for
            exactly this.
          */}
          <Typography level="body-sm" textColor="text.secondary" data-testid="scope-preflight-run-echo">
            Showing <code>{data.endpointPrefix}</code> against <code>{data.requiredScopes.join(', ')}</code> over{' '}
            {data.windowDays} days.
          </Typography>

          <Stack direction="row" spacing={1} flexWrap="wrap">
            <Chip color="danger" variant="soft" data-testid="scope-preflight-deny-count">
              {counts.deny} would 403
            </Chip>
            <Chip color="warning" variant="soft">
              {counts.stagedAllow} surviving on staging
            </Chip>
            <Chip color="success" variant="soft">
              {counts.allow} already fine
            </Chip>
          </Stack>

          {data.stagedScopes.length > 0 ? (
            <Alert color="warning">
              Staged on this stage: {data.stagedScopes.join(', ')}. Rows marked &quot;staged only&quot; pass today and
              will 403 when the staging entry is removed.
            </Alert>
          ) : null}

          {data.truncated ? (
            <Alert color="warning" data-testid="scope-preflight-truncated">
              Result cap reached - this list is partial. Narrow the prefix before treating it as complete. Do not narrow
              the window: that drops the low-traffic keys for good rather than paging past them.
            </Alert>
          ) : null}

          {data.coverage.unloggedPrefixes.length > 0 ? (
            <Alert color="warning" data-testid="scope-preflight-unlogged">
              {data.coverage.unloggedPrefixes.join(', ')} falls under this prefix and writes no usage log. Those routes
              authenticate through <code>verifyApiKey</code> rather than the <code>baseApi</code> gate, and only that
              gate records API-key traffic, so calls to them are invisible here however busy they are. Read this result
              as covering the rest of the prefix only.
            </Alert>
          ) : null}

          {data.rows.length === 0 ? (
            data.coverage.fullWindow && data.coverage.unloggedPrefixes.length === 0 ? (
              <Alert color="success" data-testid="scope-preflight-empty">
                No API key has called these routes in the last {data.windowDays} days, the full logged history. There is
                no grandfathered population to re-mint, so the gate can be declared and enforced in one step. This
                counts pre-enforcement traffic only: a request rejected by a scope gate is never logged, so if these
                routes already require a scope, the keys being turned away today do not appear here.
              </Alert>
            ) : (
              // An empty list is only actionable when the run saw everything there
              // was to see. Short of that it is an absence of evidence, and the
              // "enforce in one step" advice above would license the exact
              // one-shot rollout this tool exists to prevent.
              <Alert color="warning" data-testid="scope-preflight-empty-inconclusive">
                No API key called these routes in the last {data.windowDays} days, but this run did not cover enough to
                enforce on.{' '}
                {!data.coverage.fullWindow
                  ? `A key that fires monthly or quarterly leaves no trace in a ${data.windowDays}-day window - re-run at ${FULL_WINDOW_DAYS} days before deciding. `
                  : null}
                {data.coverage.unloggedPrefixes.length > 0
                  ? 'Unlogged routes under this prefix are not counted. '
                  : null}
                Do not skip the staging sequence on this result.
              </Alert>
            )
          ) : (
            <Table size="sm" stickyHeader data-testid="scope-preflight-results">
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th>Key</th>
                  <th>User</th>
                  <th>Held scopes</th>
                  <th>Requests</th>
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(row => (
                  <tr key={row.keyId}>
                    <td>
                      <OutcomeChip outcome={row.outcome} />
                    </td>
                    <td>
                      <Typography level="body-xs" fontFamily="monospace">
                        {row.keyId}
                      </Typography>
                    </td>
                    <td>
                      <Typography level="body-xs" fontFamily="monospace">
                        {row.userId}
                      </Typography>
                    </td>
                    <td>
                      <Typography level="body-xs">
                        {row.heldScopes.length > 0 ? row.heldScopes.join(', ') : 'none'}
                      </Typography>
                    </td>
                    <td>{row.requests}</td>
                    <td>
                      <Typography level="body-xs">{new Date(row.lastUsed).toLocaleDateString()}</Typography>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Stack>
      ) : null}
    </Stack>
  );
};

export default ApiKeyScopePreflightTab;

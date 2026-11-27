import React from 'react';
import { vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AdminModelRow } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import type { DiscoveryRun, DiscoveryStatus, LifecycleStatus } from '../discoveryApi';

/** Fixtures and a render wrapper shared by the Discovery tests. */

const appTheme = extendTheme({ ...getThemeConfig() });

export const newQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity } } });

export const makeWrapper = (queryClient: QueryClient) =>
  function TestWrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
      </QueryClientProvider>
    );
  };

export const FULL_ADMIN = { id: 'admin-1', isAdmin: true };
/** Holds settings:manage but is not a full admin: reads pass, model writes are blocked. */
export const DELEGATE = { id: 'delegate-1', isAdmin: false, adminPermissions: ['settings:manage', 'support:read'] };
export const SUPPORT_ONLY = { id: 'support-1', isAdmin: false, adminPermissions: ['support:read'] };

export const CRON_RUN = {
  id: 'run-1',
  startedAt: '2026-07-26T12:00:00.000Z',
  finishedAt: '2026-07-26T12:03:00.000Z',
  trigger: 'cron',
  host: 'hosted',
  status: 'partial' as const,
  mode: 'write' as const,
  sources: [
    { name: 'openai', ok: true, durationMs: 120 },
    { name: 'anthropic', ok: true, durationMs: 140 },
    { name: 'models.dev', ok: false, durationMs: 900, error: 'ETIMEDOUT' },
  ],
  skippedSources: [] as Array<{ name: string; reason: string }>,
  joinCoverage: [{ aggregator: 'models.dev', matched: 84, total: 113 }],
  changes: { added: 2, promoted: 1, deprecated: 0, repriced: 0, flagged: 0 },
};

export type LastRun = NonNullable<DiscoveryStatus['lastRun']>;

export const listOf = (run: LastRun) => ({
  id: run.id,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  trigger: run.trigger,
  host: run.host,
  status: run.status,
  mode: run.mode,
  changes: run.changes,
});

export const STATUS: DiscoveryStatus = {
  lastRun: CRON_RUN,
  runs: [listOf(CRON_RUN)],
  lastSuccessfulRunAt: '2026-07-26T06:00:00.000Z',
  enabled: true,
  mode: 'write',
  autoEnable: 'priced',
  selfHost: false,
};

export const runLike = (over: Partial<LastRun>): LastRun => ({ ...CRON_RUN, ...over });

/** runs[0] is lastRun by construction server-side; the fixture keeps that true. */
export const statusWith = (lastRun: LastRun | null, over: Partial<DiscoveryStatus> = {}): DiscoveryStatus => ({
  ...STATUS,
  lastRun,
  runs: lastRun ? [listOf(lastRun)] : [],
  ...over,
});

export const EMPTY_CHANGES: DiscoveryRun['changes'] = {
  added: [],
  promoted: [],
  deprecated: [],
  repriced: [],
  flagged: [],
  operatorConflicts: [],
  plannedRows: 0,
  appendedRows: 0,
  plannedPriceRows: 0,
  appendedPriceRows: 0,
};

/** The production flag that had no explanation anywhere but a log line. */
export const LUNA_FLAG = {
  modelId: 'gpt-5.6-luna',
  kind: 'source-disagreement',
  proposed: { inputPerMTok: 0.2, outputPerMTok: 1.2 },
  current: { inputPerMTok: 1, outputPerMTok: 6 },
  sources: ['models.dev', 'litellm'],
  detail: 'sources disagree beyond 10%: models.dev in 0.2/out 1.2 vs litellm in 1/out 6; applied neither',
};

export const RUN: DiscoveryRun = {
  id: 'run-1',
  startedAt: '2026-07-30T12:00:00.000Z',
  finishedAt: '2026-07-30T12:03:00.000Z',
  trigger: 'cron',
  host: 'hosted',
  status: 'ok',
  mode: 'write',
  passes: 2,
  sources: [
    { name: 'models.dev', ok: true, durationMs: 120, httpStatus: 200, recordCount: 113 },
    { name: 'litellm', ok: false, durationMs: 900, error: 'ETIMEDOUT' },
  ],
  joinCoverage: [{ aggregator: 'models.dev', matched: 84, total: 113 }],
  changes: { ...EMPTY_CHANGES, flagged: ['gpt-5.6-luna'], plannedPriceRows: 1, appendedPriceRows: 1 },
  priceFlags: [LUNA_FLAG],
  priceRows: [],
  priceOverrides: [],
  longContextGaps: [],
  priceSkips: [],
  lifecycleTransitions: [],
  catalogDiff: [],
  detailTotals: {},
  unmatchedIds: [],
  frozenProfileIds: [],
  droppedRecords: [],
};

export const runWith = (over: Partial<DiscoveryRun>): DiscoveryRun => ({ ...RUN, ...over });

export const LIFECYCLE: LifecycleStatus = {
  queue: [
    {
      modelId: 'gpt-sunset',
      suggestion: {
        status: 'deprecated',
        deprecationDate: '2026-08-01',
        replacedBy: 'gpt-live',
        source: 'anthropic-docs',
        suggestedAt: '2026-07-20T00:00:00.000Z',
      },
    },
  ],
  perMTokRates: {
    'gpt-sunset': { input: 0.3, output: 0.5 },
    'gpt-live': { input: 2, output: 6 },
    'gpt-newer': { input: 0.1, output: 0.25 },
  },
  staleReferences: [
    { surface: 'fallback-chain', key: 'gpt-live', referencedId: 'gpt-sunset', problem: 'deprecated' },
    { surface: 'fallback-default', key: 'default', referencedId: 'gpt-ghost', problem: 'unknown' },
    { surface: 'fallback-chain', key: 'gpt-live', referencedId: 'gpt-metadata-only', problem: 'not-invocable' },
  ],
};

export const adminRow = (id: string, over: Partial<AdminModelRow> = {}): AdminModelRow => ({
  id,
  name: `Model ${id}`,
  type: 'text',
  backend: 'openai',
  private: false,
  freeToRun: false,
  status: 'listed',
  reasons: [],
  rank: 1,
  rankProvisional: false,
  origin: 'default',
  adminEdited: false,
  keyPresent: true,
  access: { entry: null, everyone: true, adminsOnly: false, freeTierLocked: false },
  price: null,
  lifecycle: {},
  sunsetDate: null,
  sunsetDays: null,
  lifecycleSuggestion: null,
  firstSeenAt: null,
  profileOnlyFoundation: false,
  ...over,
});

export const modelList = (rows: AdminModelRow[]) => ({
  models: rows,
  total: rows.length,
  page: 1,
  pageSize: 500,
  counts: { listed: 0, limited: 0, 'needs-review': 0, hidden: 0, retiring: 0, retired: 0 },
  foundationIds: 0,
  facets: { providers: [], types: [] },
});

export const navMock = () => ({
  openModel: vi.fn(),
  openRun: vi.fn(),
  openSection: vi.fn(),
  openPrices: vi.fn(),
});

/** An axios-shaped rejection. */
export const apiError = (status: number, data: Record<string, unknown>) => ({
  message: `Request failed with status code ${status}`,
  response: { status, data },
});

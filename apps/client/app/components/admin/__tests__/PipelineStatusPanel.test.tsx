import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mockGet, post: mockPost },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));

vi.mock('@client/app/utils/react-query', () => ({
  replaceQueryData: vi.fn(),
  setOptimisticQueryData: vi.fn(),
  updateSingleQueryDataFast: vi.fn(),
}));

import { PipelineStatusPanel, isClosedGithubIssueDoc, type TrackingDocSummary } from '../SreAgentTab';
import type { SreMetrics } from '@bike4mind/common';

const HIDE_TOGGLE_LABEL = 'Hide tracking for closed GitHub issues';
const STORAGE_KEY = 'sre-pipeline-hide-closed-issues';

// The panel embeds SreMetricsWidget, which fetches /api/sre/metrics on mount.
// These tests exercise the closed-issue filter, not metrics, so serve an empty
// window (the widget renders its own empty state and stays out of the way).
const EMPTY_METRICS: SreMetrics = {
  windowMs: 7 * 24 * 60 * 60 * 1000,
  total: 0,
  bySource: { CLOUDWATCH: 0, GITHUB_ISSUE: 0 },
  byStatus: {},
  analysesRun: 0,
  fixesDispatched: 0,
  prsCreated: 0,
  prsMerged: 0,
  tokens: { input: 0, output: 0 },
};

// A: open GitHub issue (visible always). B: closed GitHub issue (hidden by default).
// C: CloudWatch, no linked issue (visible always). D: GitHub issue, state never observed (visible always).
const docs: TrackingDocSummary[] = [
  {
    id: 'A',
    _id: 'A',
    errorFingerprint: 'fpAAAAAAAAAA',
    repoSlug: 'owner/repo',
    source: 'GITHUB_ISSUE',
    status: 'awaiting_approval',
    githubIssueNumber: 1,
    githubIssueState: 'open',
    errorMessage: 'Open issue error',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  },
  {
    id: 'B',
    _id: 'B',
    errorFingerprint: 'fpBBBBBBBBBB',
    repoSlug: 'owner/repo',
    source: 'GITHUB_ISSUE',
    status: 'fixed',
    githubIssueNumber: 2,
    githubIssueState: 'closed',
    errorMessage: 'Closed issue error',
    createdAt: new Date('2026-07-02T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
  },
  {
    id: 'C',
    _id: 'C',
    errorFingerprint: 'fpCCCCCCCCCC',
    repoSlug: 'owner/repo',
    source: 'CLOUDWATCH',
    status: 'analyzing',
    errorMessage: 'CloudWatch error',
    createdAt: new Date('2026-07-03T00:00:00.000Z'),
    updatedAt: new Date('2026-07-03T00:00:00.000Z'),
  },
  {
    id: 'D',
    _id: 'D',
    errorFingerprint: 'fpDDDDDDDDDD',
    repoSlug: 'owner/repo',
    source: 'GITHUB_ISSUE',
    status: 'failed',
    githubIssueNumber: 4,
    // githubIssueState intentionally absent - state not yet observed
    errorMessage: 'Unobserved issue error',
    createdAt: new Date('2026-07-04T00:00:00.000Z'),
    updatedAt: new Date('2026-07-04T00:00:00.000Z'),
  },
];

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const theme = extendTheme({ ...getThemeConfig() });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <PipelineStatusPanel repoSlugs={['owner/repo']} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
}

describe('isClosedGithubIssueDoc', () => {
  it('is true only when githubIssueState is "closed"', () => {
    expect(isClosedGithubIssueDoc({ githubIssueState: 'closed' })).toBe(true);
    expect(isClosedGithubIssueDoc({ githubIssueState: 'open' })).toBe(false);
    expect(isClosedGithubIssueDoc({ githubIssueState: undefined })).toBe(false);
    expect(isClosedGithubIssueDoc({})).toBe(false);
  });
});

describe('PipelineStatusPanel - closed-issue filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mockGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/sre/metrics')) return Promise.resolve({ data: EMPTY_METRICS });
      if (url.endsWith('/issue-state')) return Promise.resolve({ data: { state: 'open' } });
      if (url === '/api/sre/tracking' || url.startsWith('/api/sre/tracking?')) {
        return Promise.resolve({ data: docs });
      }
      return Promise.resolve({ data: {} });
    });
    mockPost.mockResolvedValue({ data: {} });
  });

  it('checks the "hide closed issues" toggle by default and hides closed-issue docs', async () => {
    renderPanel();

    await screen.findByTestId('sre-tracking-card-A');

    // Toggle is checked by default.
    expect(screen.getByLabelText(HIDE_TOGGLE_LABEL)).toBeChecked();

    // Open GitHub issue, CloudWatch, and never-observed GitHub docs stay visible.
    expect(screen.getByTestId('sre-tracking-card-A')).toBeInTheDocument();
    expect(screen.getByTestId('sre-tracking-card-C')).toBeInTheDocument();
    expect(screen.getByTestId('sre-tracking-card-D')).toBeInTheDocument();

    // Closed GitHub issue doc is hidden.
    expect(screen.queryByTestId('sre-tracking-card-B')).not.toBeInTheDocument();

    // Surfaces how many were hidden so operators know the tail exists.
    expect(screen.getByTestId('sre-pipeline-hidden-count')).toHaveTextContent('1 closed-issue doc hidden');
  });

  it('shows closed-issue docs when the toggle is unchecked', async () => {
    renderPanel();
    await screen.findByTestId('sre-tracking-card-A');

    fireEvent.click(screen.getByLabelText(HIDE_TOGGLE_LABEL));

    await waitFor(() => expect(screen.getByTestId('sre-tracking-card-B')).toBeInTheDocument());
    // All four now visible; nothing hidden.
    expect(screen.getByTestId('sre-tracking-card-A')).toBeInTheDocument();
    expect(screen.getByTestId('sre-tracking-card-C')).toBeInTheDocument();
    expect(screen.getByTestId('sre-tracking-card-D')).toBeInTheDocument();
    expect(screen.queryByTestId('sre-pipeline-hidden-count')).not.toBeInTheDocument();
  });

  it('never hides CloudWatch-sourced docs regardless of toggle state', async () => {
    renderPanel();
    await screen.findByTestId('sre-tracking-card-C');

    // Visible while filter is on...
    expect(screen.getByTestId('sre-tracking-card-C')).toBeInTheDocument();

    // ...and still visible after toggling off.
    fireEvent.click(screen.getByLabelText(HIDE_TOGGLE_LABEL));
    await waitFor(() => expect(screen.getByTestId('sre-tracking-card-B')).toBeInTheDocument());
    expect(screen.getByTestId('sre-tracking-card-C')).toBeInTheDocument();
  });

  it('persists the toggle state to sessionStorage and restores it on mount', async () => {
    // Pre-seed an unchecked preference from a prior render in the same session.
    window.sessionStorage.setItem(STORAGE_KEY, 'false');

    renderPanel();
    await screen.findByTestId('sre-tracking-card-A');

    // Restored as unchecked -> closed doc B visible.
    expect(screen.getByLabelText(HIDE_TOGGLE_LABEL)).not.toBeChecked();
    expect(screen.getByTestId('sre-tracking-card-B')).toBeInTheDocument();

    // Re-checking writes the preference back.
    fireEvent.click(screen.getByLabelText(HIDE_TOGGLE_LABEL));
    await waitFor(() => expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('true'));
  });

  it('fires the issue-state self-heal for a GitHub-issue doc whose number is not yet backfilled', async () => {
    // GITHUB_ISSUE doc with githubIssueNumber absent - its number lives only in the
    // server-side sourceRef. The card must still call the issue-state endpoint so
    // the server can parse sourceRef, backfill, and reconcile githubIssueState.
    const numberless: TrackingDocSummary = {
      id: 'E',
      _id: 'E',
      errorFingerprint: 'fpEEEEEEEEEE',
      repoSlug: 'owner/repo',
      source: 'GITHUB_ISSUE',
      status: 'detected',
      // githubIssueNumber intentionally absent
      errorMessage: 'Numberless issue error',
      createdAt: new Date('2026-07-05T00:00:00.000Z'),
      updatedAt: new Date('2026-07-05T00:00:00.000Z'),
    };
    mockGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/sre/metrics')) return Promise.resolve({ data: EMPTY_METRICS });
      if (url.endsWith('/issue-state')) return Promise.resolve({ data: { state: 'open' } });
      if (url === '/api/sre/tracking' || url.startsWith('/api/sre/tracking?')) {
        return Promise.resolve({ data: [numberless, docs[2]] }); // numberless GH doc + a CloudWatch doc
      }
      return Promise.resolve({ data: {} });
    });

    renderPanel();
    await screen.findByTestId('sre-tracking-card-E');

    // The numberless GitHub-issue doc still triggers the self-heal fetch...
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/sre/tracking/E/issue-state'));
    // ...while the CloudWatch doc (no linked issue) never does.
    expect(mockGet).not.toHaveBeenCalledWith('/api/sre/tracking/C/issue-state');
  });

  it('shows an explanatory message when every doc is filtered out', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/sre/metrics')) return Promise.resolve({ data: EMPTY_METRICS });
      if (url.endsWith('/issue-state')) return Promise.resolve({ data: { state: 'closed' } });
      if (url === '/api/sre/tracking' || url.startsWith('/api/sre/tracking?')) {
        return Promise.resolve({ data: [docs[1]] }); // only the closed-issue doc
      }
      return Promise.resolve({ data: {} });
    });

    renderPanel();

    const emptyState = await screen.findByTestId('sre-pipeline-all-hidden');
    expect(emptyState).toHaveTextContent('closed GitHub issue');
    expect(screen.queryByTestId('sre-tracking-card-B')).not.toBeInTheDocument();
  });
});

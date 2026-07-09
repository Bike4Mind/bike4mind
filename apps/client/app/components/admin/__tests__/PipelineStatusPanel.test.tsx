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

const HIDE_TOGGLE_LABEL = 'Hide tracking for closed GitHub issues';
const STORAGE_KEY = 'sre-pipeline-hide-closed-issues';

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

  it('shows an explanatory message when every doc is filtered out', async () => {
    mockGet.mockImplementation((url: string) => {
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

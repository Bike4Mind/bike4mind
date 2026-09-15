import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockGet, mockToast, mockToastError } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockToast: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mockGet },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(mockToast, { error: mockToastError }),
}));

vi.mock('@client/app/utils/react-query', () => ({
  replaceQueryData: vi.fn(),
  setOptimisticQueryData: vi.fn(),
  updateSingleQueryDataFast: vi.fn(),
}));

import { TrackingDetailDrawer } from '../TrackingDetailDrawer';
import { PipelineTrackingCard, type TrackingDocSummary } from '../SreAgentTab';

const fullDoc = {
  id: 'abc123',
  _id: 'abc123',
  errorFingerprint: 'fp-deadbeef1234567890',
  repoSlug: 'MillionOnMars/lumina5',
  source: 'CLOUDWATCH' as const,
  sourceRef: 'https://github.com/MillionOnMars/lumina5/issues/42',
  status: 'fixed' as const,
  dryRun: true,
  affectedUserIds: ['user1', 'user2'],
  classification: 'HIGH' as const,
  errorMessage: 'TypeError: Cannot read properties of undefined',
  diagnosisResult: {
    rootCause: 'Null reference in handler',
    proposedFix: 'Add null check before accessing property',
    confidence: 85,
    riskAssessment: 'Low risk — isolated change',
    affectedFiles: [{ filePath: 'src/handler.ts', before: 'const x = obj.prop;', after: 'const x = obj?.prop;' }],
    toolCalls: [
      { tool: 'readFile', input: { path: 'src/handler.ts' }, output: 'file contents...' },
      { tool: 'grep', input: { pattern: 'obj.prop' }, output: 'match found' },
    ],
  },
  githubIssueNumber: 42,
  fixPrNumber: 100,
  fixPrSha: 'abc1234567890',
  fixMergedAt: '2026-03-10T12:00:00Z',
  userNotifiedAt: '2026-03-10T13:00:00Z',
  workflowRunUrl: 'https://github.com/MillionOnMars/lumina5/actions/runs/123',
  dispatchedAt: '2026-03-10T11:00:00Z',
  llmTokensUsed: { input: 5000, output: 2000 },
  previousFixFingerprint: 'fp-prev-00000000',
  createdAt: '2026-03-10T10:00:00Z',
  updatedAt: '2026-03-10T14:00:00Z',
};

const minimalDoc = {
  id: 'min456',
  _id: 'min456',
  errorFingerprint: 'fp-minimal',
  source: 'GITHUB_ISSUE' as const,
  sourceRef: 'log-group-name',
  status: 'analyzing' as const,
  affectedUserIds: [],
  errorMessage: 'Some error',
  createdAt: '2026-03-10T10:00:00Z',
  updatedAt: '2026-03-10T10:05:00Z',
};

function renderDrawer(props: { trackingId: string | null; open: boolean; onClose?: () => void }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TrackingDetailDrawer trackingId={props.trackingId} open={props.open} onClose={props.onClose ?? vi.fn()} />
    </QueryClientProvider>
  );
}

describe('TrackingDetailDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all sections for a fully-populated document', async () => {
    mockGet.mockResolvedValue({ data: fullDoc });
    renderDrawer({ trackingId: 'abc123', open: true });

    // Wait for data to load (query must resolve and re-render)
    await waitFor(
      () => {
        expect(screen.getByText('fp-deadbeef1234567890')).toBeInTheDocument();
      },
      { timeout: 3000 }
    );

    // Status and classification chips
    expect(screen.getByText('fixed')).toBeInTheDocument();
    expect(screen.getByText('HIGH')).toBeInTheDocument();
    expect(screen.getByText('DRY RUN')).toBeInTheDocument();

    // Overview
    expect(screen.getByText('fp-deadbeef1234567890')).toBeInTheDocument();
    expect(screen.getByText('CLOUDWATCH')).toBeInTheDocument();
    expect(screen.getByText('TypeError: Cannot read properties of undefined')).toBeInTheDocument();
    expect(screen.getByText('2 users')).toBeInTheDocument();

    // Diagnosis
    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(screen.getByText('Null reference in handler')).toBeInTheDocument();
    expect(screen.getByText('Add null check before accessing property')).toBeInTheDocument();

    // Links
    expect(screen.getByTestId('sre-tracking-link-issue')).toBeInTheDocument();
    expect(screen.getByTestId('sre-tracking-link-pr')).toBeInTheDocument();
    expect(screen.getByTestId('sre-tracking-link-workflow')).toBeInTheDocument();

    // Copy JSON button
    expect(screen.getByTestId('sre-tracking-copy-json')).toBeInTheDocument();
  });

  it('shows "Diagnosis not available" for minimal document', async () => {
    mockGet.mockResolvedValue({ data: minimalDoc });
    renderDrawer({ trackingId: 'min456', open: true });

    await waitFor(
      () => {
        expect(screen.getByText(/Diagnosis not available/)).toBeInTheDocument();
      },
      { timeout: 3000 }
    );

    expect(screen.getByText('analyzing')).toBeInTheDocument();
  });

  it('close button calls onClose', async () => {
    mockGet.mockResolvedValue({ data: fullDoc });
    const onClose = vi.fn();
    renderDrawer({ trackingId: 'abc123', open: true, onClose });

    await waitFor(() => {
      expect(screen.getByTestId('sre-tracking-drawer-close')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('sre-tracking-drawer-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not fetch when trackingId is null', () => {
    renderDrawer({ trackingId: null, open: true });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('does not fetch when drawer is closed', () => {
    renderDrawer({ trackingId: 'abc123', open: false });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('copy fingerprint button copies fingerprint', async () => {
    mockGet.mockResolvedValue({ data: fullDoc });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderDrawer({ trackingId: 'abc123', open: true });

    await waitFor(() => {
      expect(screen.getByTestId('sre-tracking-copy-fingerprint')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('sre-tracking-copy-fingerprint'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('fp-deadbeef1234567890');
      expect(mockToast).toHaveBeenCalledWith('Fingerprint copied to clipboard');
    });
  });

  it('copy JSON button copies full document', async () => {
    mockGet.mockResolvedValue({ data: fullDoc });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderDrawer({ trackingId: 'abc123', open: true });

    await waitFor(() => {
      expect(screen.getByTestId('sre-tracking-copy-json')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('sre-tracking-copy-json'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(JSON.stringify(fullDoc, null, 2));
      expect(mockToast).toHaveBeenCalledWith('Full JSON copied to clipboard');
    });
  });

  it('expands tool calls accordion to show tool details', async () => {
    mockGet.mockResolvedValue({ data: fullDoc });
    renderDrawer({ trackingId: 'abc123', open: true });

    await waitFor(() => {
      expect(screen.getByText('Tool Calls')).toBeInTheDocument();
    });

    // Click to expand
    fireEvent.click(screen.getByText('Tool Calls'));

    await waitFor(() => {
      expect(screen.getByText('readFile')).toBeInTheDocument();
      expect(screen.getByText('grep')).toBeInTheDocument();
    });
  });

  it('expands affected files accordion to show file details', async () => {
    mockGet.mockResolvedValue({ data: fullDoc });
    renderDrawer({ trackingId: 'abc123', open: true });

    await waitFor(() => {
      expect(screen.getByText('Affected Files')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Affected Files'));

    await waitFor(() => {
      expect(screen.getByText('src/handler.ts')).toBeInTheDocument();
    });
  });
});

// PipelineTrackingCard Tests

const cardDocWithId: TrackingDocSummary = {
  id: 'card-with-id',
  errorFingerprint: 'fp-card-id-test',
  source: 'CLOUDWATCH',
  status: 'analyzing',
  errorMessage: 'Test error message',
  createdAt: '2026-03-10T10:00:00Z',
  updatedAt: '2026-03-10T14:00:00Z',
};

const cardDocWithOnlyUnderscoreId: TrackingDocSummary = {
  _id: 'card-underscore-only',
  errorFingerprint: 'fp-card-underscore-test',
  source: 'GITHUB_ISSUE',
  status: 'fixed',
  errorMessage: 'Underscore ID error',
  fixPrNumber: 42,
  diagnosisResult: { confidence: 90, rootCause: 'Null ref' },
  createdAt: '2026-03-10T10:00:00Z',
  updatedAt: '2026-03-10T14:00:00Z',
};

function renderCard(doc: TrackingDocSummary) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PipelineTrackingCard doc={doc} />
    </QueryClientProvider>
  );
}

describe('PipelineTrackingCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders card and fetches detail using doc.id when present', async () => {
    mockGet.mockResolvedValue({ data: fullDoc });
    renderCard(cardDocWithId);

    expect(screen.getByTestId('sre-tracking-card-card-with-id')).toBeInTheDocument();
    expect(screen.getByText('analyzing')).toBeInTheDocument();

    // Expand accordion - click the button inside the summary via data-testid
    const summary = screen.getByTestId('sre-tracking-expand-card-with-id');
    fireEvent.click(within(summary).getByRole('button'));

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith('/api/sre/tracking/card-with-id');
    });
  });

  it('falls back to _id when id is undefined and fetches detail correctly', async () => {
    mockGet.mockResolvedValue({ data: fullDoc });
    renderCard(cardDocWithOnlyUnderscoreId);

    expect(screen.getByTestId('sre-tracking-card-card-underscore-only')).toBeInTheDocument();
    expect(screen.getByText('fixed')).toBeInTheDocument();

    // Expand accordion - click the button inside the summary via data-testid
    const summary = screen.getByTestId('sre-tracking-expand-card-underscore-only');
    fireEvent.click(within(summary).getByRole('button'));

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith('/api/sre/tracking/card-underscore-only');
    });
  });

  it('displays labels on card summary', () => {
    renderCard(cardDocWithOnlyUnderscoreId);

    expect(screen.getByText('Status:')).toBeInTheDocument();
    expect(screen.getByText('Source:')).toBeInTheDocument();
    expect(screen.getByText(/Updated:/)).toBeInTheDocument();
    expect(screen.getByText(/Confidence: 90%/)).toBeInTheDocument();
    expect(screen.getByText('PR #42')).toBeInTheDocument();
  });

  it('has aria-label on accordion summary', () => {
    renderCard(cardDocWithOnlyUnderscoreId);

    const summary = screen.getByTestId('sre-tracking-expand-card-underscore-only');
    expect(summary).toHaveAttribute('aria-label', 'Details for error fp-card-unde');
  });
});

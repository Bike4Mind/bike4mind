import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IImportHistoryJob } from '@bike4mind/database/content';

type LiveProgress = {
  status: IImportHistoryJob['status'];
  progress: number;
  currentStep: string;
  errorMessage?: string;
} | null;

const hooks = vi.hoisted(() => ({
  jobs: [] as Partial<IImportHistoryJob>[],
  live: {} as Record<string, LiveProgress>,
}));

vi.mock('@client/app/hooks/data/importHistoryJobs', () => ({
  useListImportHistoryJobs: () => ({
    data: { data: hooks.jobs, total: hooks.jobs.length, hasMore: false },
    isLoading: false,
    refetch: vi.fn(),
  }),
  useRetryImportHistoryJob: () => ({ mutate: vi.fn(), isPending: false }),
  useImportHistoryJobWebSocket: (id: string) => hooks.live[id] ?? null,
}));

import ImportHistoryJobsList from './ImportHistoryJobsList';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const makeJob = (overrides: Partial<IImportHistoryJob>): Partial<IImportHistoryJob> => ({
  id: 'job-1',
  source: 'OpenAI',
  status: 'failed',
  progress: 0,
  currentStep: 'Import failed',
  processedItems: 0,
  totalItems: 0,
  fileSize: 1024,
  createdAt: new Date(),
  ...overrides,
});

const renderList = () =>
  render(
    <TestWrapper>
      <ImportHistoryJobsList />
    </TestWrapper>
  );

describe('ImportHistoryJobsList failed rows', () => {
  beforeEach(() => {
    hooks.jobs = [];
    hooks.live = {};
  });

  it('shows the mapped reason and hides Retry for a file that is not an export', () => {
    hooks.jobs = [makeJob({ errorMessage: 'conversations.json not found in archive' })];
    renderList();

    expect(screen.getByTestId('import-job-failure-reason-job-1')).toHaveTextContent(
      "This file doesn't look like a ChatGPT export (no conversations.json)."
    );
    expect(screen.getByText('Import failed')).toBeInTheDocument();
    expect(screen.queryByTestId('retry-import-job-1')).not.toBeInTheDocument();
  });

  it('shows the generic reason and keeps Retry when there is no error message', () => {
    hooks.jobs = [makeJob({ errorMessage: undefined })];
    renderList();

    expect(screen.getByTestId('import-job-failure-reason-job-1')).toHaveTextContent(
      'Something went wrong on our side while processing this import.'
    );
    expect(screen.getByTestId('retry-import-job-1')).toBeInTheDocument();
  });

  it('keeps a Notebook JSON failure generic and retryable', () => {
    hooks.jobs = [makeJob({ source: 'Notebook', errorMessage: 'Unexpected token } in JSON at position 12' })];
    renderList();

    expect(screen.getByTestId('import-job-failure-reason-job-1')).toHaveTextContent(
      'Something went wrong on our side while processing this import.'
    );
    expect(screen.getByTestId('retry-import-job-1')).toBeInTheDocument();
  });

  it('never renders the raw error message', () => {
    const raw = 'ENOENT: no such file /tmp/import-user-123/upload.zip';
    hooks.jobs = [makeJob({ errorMessage: raw })];
    renderList();

    expect(screen.queryByText(raw, { exact: false })).not.toBeInTheDocument();
    expect(screen.getByTestId('import-job-failure-reason-job-1')).not.toHaveTextContent('/tmp/');
  });

  it('shows Import failed for a legacy row saved with the step it died on', () => {
    hooks.jobs = [makeJob({ currentStep: 'Downloading and extracting file...', errorMessage: undefined })];
    renderList();

    expect(screen.getByText('Import failed')).toBeInTheDocument();
    expect(screen.queryByText('Downloading and extracting file...')).not.toBeInTheDocument();
  });

  it('uses the live failed payload for a row still stored as processing, including zero counts', () => {
    hooks.jobs = [
      makeJob({
        status: 'processing',
        progress: 40,
        processedItems: 5,
        totalItems: 10,
        currentStep: 'Parsing conversations...',
      }),
    ];
    hooks.live = {
      'job-1': {
        status: 'failed',
        progress: 0,
        processedItems: 0,
        totalItems: 4,
        currentStep: 'Import failed',
        errorMessage: 'end of central directory record signature not found',
      },
    };
    renderList();

    expect(screen.getByTestId('import-job-failure-reason-job-1')).toHaveTextContent(
      'This file is not a valid .zip archive.'
    );
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText('0/4 items')).toBeInTheDocument();
    expect(screen.queryByTestId('retry-import-job-1')).not.toBeInTheDocument();
  });

  it('renders no reason on a completed row', () => {
    hooks.jobs = [makeJob({ status: 'completed', progress: 100, currentStep: 'Import completed successfully' })];
    renderList();

    expect(screen.queryByTestId('import-job-failure-reason-job-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('retry-import-job-1')).not.toBeInTheDocument();
  });
});

import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IImportHistoryJob } from '@bike4mind/database/content';

const h = vi.hoisted(() => ({
  jobs: [] as Partial<IImportHistoryJob>[],
  liveProgress: null as Record<string, unknown> | null,
}));

vi.mock('@client/app/hooks/data/importHistoryJobs', () => ({
  useListImportHistoryJobs: () => ({
    data: { data: h.jobs, total: h.jobs.length, hasMore: false },
    isLoading: false,
    refetch: vi.fn(),
  }),
  useRetryImportHistoryJob: () => ({ mutate: vi.fn(), isPending: false }),
  useImportHistoryJobWebSocket: () => h.liveProgress,
}));

import ImportHistoryJobsList from './ImportHistoryJobsList';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const job = (overrides: Partial<IImportHistoryJob>): Partial<IImportHistoryJob> => ({
  id: 'job-1',
  source: 'OpenAI',
  status: 'failed',
  progress: 0,
  currentStep: 'Downloading and extracting file...',
  processedItems: 0,
  totalItems: 0,
  fileSize: 2048,
  createdAt: new Date(),
  ...overrides,
});

const renderList = () =>
  render(
    <TestWrapper>
      <ImportHistoryJobsList />
    </TestWrapper>
  );

beforeEach(() => {
  h.jobs = [];
  h.liveProgress = null;
});

describe('ImportHistoryJobsList failed rows', () => {
  it('shows the mapped reason instead of the stale step text', () => {
    h.jobs = [job({ errorMessage: 'conversations.json not found in archive' })];

    renderList();

    expect(screen.getByTestId('import-job-failure-reason-job-1')).toHaveTextContent(
      "This file isn't a ChatGPT or Claude export."
    );
    expect(screen.queryByText('Downloading and extracting file...')).not.toBeInTheDocument();
    expect(screen.queryByText('conversations.json not found in archive')).not.toBeInTheDocument();
  });

  it('hides Retry when the uploaded file itself is unusable', () => {
    h.jobs = [job({ errorMessage: 'end of central directory record signature not found' })];

    renderList();

    expect(screen.getByTestId('import-job-failure-reason-job-1')).toHaveTextContent("isn't a zip archive");
    expect(screen.queryByTestId('retry-import-job-1')).not.toBeInTheDocument();
  });

  it('keeps Retry with a generic reason for an unrecognized error', () => {
    h.jobs = [job({ errorMessage: 'connect ECONNRESET 10.0.0.1:27017' })];

    renderList();

    expect(screen.getByTestId('import-job-failure-reason-job-1')).toHaveTextContent(
      'Something went wrong during the import'
    );
    expect(screen.queryByText(/ECONNRESET/)).not.toBeInTheDocument();
    expect(screen.getByTestId('retry-import-job-1')).toBeInTheDocument();
  });

  it('uses the live failure pushed over the websocket before the list refetches', () => {
    h.jobs = [job({ status: 'processing', errorMessage: undefined })];
    h.liveProgress = {
      status: 'failed',
      progress: 0,
      currentStep: 'Import failed',
      errorMessage: 'Unexpected end of JSON input',
    };

    renderList();

    expect(screen.getByTestId('import-job-failure-reason-job-1')).toHaveTextContent('The export file is damaged.');
  });

  it('shows progress, not a reason, for a job that is still processing', () => {
    h.jobs = [job({ status: 'processing', progress: 40, currentStep: 'Processing conversations: 20/50' })];

    renderList();

    expect(screen.getByText('Processing conversations: 20/50')).toBeInTheDocument();
    expect(screen.queryByTestId('import-job-failure-reason-job-1')).not.toBeInTheDocument();
  });
});

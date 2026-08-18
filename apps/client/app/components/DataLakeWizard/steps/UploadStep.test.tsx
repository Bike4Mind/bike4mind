import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import type { UploadProgress } from '@client/app/stores/useDataLakeWizardStore';
import UploadStep from './UploadStep';

/**
 * Regression coverage for #828: the completion summary must never claim
 * "chunked and vectorized" until the real chunk/vector counts reach the total.
 * In self-host without the worker those counts stay at 0 (see #822).
 */

// The WebSocket listener is exercised elsewhere; here we drive the store directly.
vi.mock('@client/app/hooks/data/dataLakeWizard', () => ({
  useBatchProgressListener: () => {},
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

function renderComplete(overrides: Partial<UploadProgress>) {
  useDataLakeWizardStore.setState({
    uploadProgress: {
      totalFiles: 0,
      uploadedFiles: 0,
      chunkedFiles: 0,
      vectorizedFiles: 0,
      failedFiles: 0,
      failedFileNames: [],
      processingFailedFiles: 0,
      status: 'complete',
      ...overrides,
    },
  });
  return render(
    <TestWrapper>
      <UploadStep />
    </TestWrapper>
  );
}

describe('UploadStep — completion summary', () => {
  afterEach(() => {
    useDataLakeWizardStore.getState().resetWizard();
  });

  it('claims chunked and vectorized only when both counts reach the total', () => {
    renderComplete({ totalFiles: 3, uploadedFiles: 3, chunkedFiles: 3, vectorizedFiles: 3 });
    expect(screen.getByText('3 files uploaded, chunked, and vectorized.')).toBeInTheDocument();
  });

  it('does not claim vectorized when nothing was processed (self-host, no worker)', () => {
    renderComplete({ totalFiles: 3, uploadedFiles: 3, chunkedFiles: 0, vectorizedFiles: 0 });
    const summary = screen.getByText(/uploaded/i);
    expect(summary).toHaveTextContent('3 files uploaded - chunking and vectorizing in progress.');
    expect(summary).not.toHaveTextContent('vectorized.');
  });

  it('reports the real partial counts while processing is in flight', () => {
    renderComplete({ totalFiles: 4, uploadedFiles: 4, chunkedFiles: 4, vectorizedFiles: 1 });
    expect(screen.getByText('4 files uploaded - 4 chunked, 1 vectorized so far.')).toBeInTheDocument();
  });

  it('uses singular "file" for a single upload', () => {
    renderComplete({ totalFiles: 1, uploadedFiles: 1, chunkedFiles: 1, vectorizedFiles: 1 });
    expect(screen.getByText('1 file uploaded, chunked, and vectorized.')).toBeInTheDocument();
  });

  it('names a browser-upload failure in those terms (#1412)', () => {
    renderComplete({
      totalFiles: 5,
      uploadedFiles: 3,
      chunkedFiles: 3,
      vectorizedFiles: 3,
      failedFiles: 2,
      processingFailedFiles: 0,
    });
    expect(
      screen.getByText('3 files uploaded, chunked, and vectorized. 2 files failed to upload.')
    ).toBeInTheDocument();
  });

  it('names a chunk/vectorize failure in those terms, not as a failed upload (#1412)', () => {
    renderComplete({
      totalFiles: 4,
      uploadedFiles: 4,
      chunkedFiles: 3,
      vectorizedFiles: 3,
      failedFiles: 1,
      processingFailedFiles: 1,
    });
    expect(
      screen.getByText('4 files uploaded - 3 chunked, 3 vectorized so far. 1 file failed to process.')
    ).toBeInTheDocument();
  });

  it('names both causes when a batch has one of each', () => {
    renderComplete({
      totalFiles: 6,
      uploadedFiles: 4,
      chunkedFiles: 4,
      vectorizedFiles: 4,
      failedFiles: 2,
      processingFailedFiles: 1,
    });
    expect(
      screen.getByText('4 files uploaded, chunked, and vectorized. 1 file failed to upload; 1 file failed to process.')
    ).toBeInTheDocument();
  });

  it('uses singular "file" for a single upload failure', () => {
    renderComplete({
      totalFiles: 4,
      uploadedFiles: 3,
      chunkedFiles: 3,
      vectorizedFiles: 3,
      failedFiles: 1,
      processingFailedFiles: 0,
    });
    expect(screen.getByText('3 files uploaded, chunked, and vectorized. 1 file failed to upload.')).toBeInTheDocument();
  });

  // Defensive only: today's write paths keep processingFailedFiles <= failedFiles, so this
  // combination can't occur in practice, but the displayed processing count must never exceed
  // the batch's real total failed count.
  it('clamps processingFailedFiles to the real total if it ever exceeds failedFiles', () => {
    renderComplete({
      totalFiles: 4,
      uploadedFiles: 3,
      chunkedFiles: 3,
      vectorizedFiles: 3,
      failedFiles: 1,
      processingFailedFiles: 5,
    });
    expect(
      screen.getByText('3 files uploaded, chunked, and vectorized. 1 file failed to process.')
    ).toBeInTheDocument();
  });

  // The wizard flips to 'error' when everything fails, so this fallback rarely
  // renders in practice - assert it anyway to lock the copy against 0 uploads.
  it('renders the not-started fallback when nothing was uploaded', () => {
    renderComplete({ totalFiles: 0, uploadedFiles: 0, chunkedFiles: 0, vectorizedFiles: 0 });
    expect(screen.getByText('0 files uploaded - chunking and vectorizing in progress.')).toBeInTheDocument();
  });
});

describe('UploadStep - in-progress failure alert (#1412)', () => {
  afterEach(() => {
    useDataLakeWizardStore.getState().resetWizard();
  });

  function renderUploading(overrides: Partial<UploadProgress>) {
    useDataLakeWizardStore.setState({
      uploadProgress: {
        totalFiles: 5,
        uploadedFiles: 3,
        chunkedFiles: 2,
        vectorizedFiles: 1,
        failedFiles: 0,
        failedFileNames: [],
        processingFailedFiles: 0,
        status: 'uploading',
        ...overrides,
      },
    });
    return render(
      <TestWrapper>
        <UploadStep />
      </TestWrapper>
    );
  }

  it('names a browser-upload failure while still uploading', () => {
    renderUploading({ failedFiles: 2, processingFailedFiles: 0, failedFileNames: ['a.pdf', 'b.pdf'] });
    expect(screen.getByText('2 files failed to upload')).toBeInTheDocument();
    expect(screen.getByText('a.pdf, b.pdf')).toBeInTheDocument();
  });

  it('names a processing failure distinctly, without implying an upload problem', () => {
    renderUploading({ failedFiles: 1, processingFailedFiles: 1 });
    expect(screen.getByText('1 file failed to process')).toBeInTheDocument();
  });

  it('shows no failure alert at all when nothing has failed', () => {
    renderUploading({ failedFiles: 0, processingFailedFiles: 0 });
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  });
});

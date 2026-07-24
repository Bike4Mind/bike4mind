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
    expect(summary).toHaveTextContent("3 files uploaded. Chunking and vectorizing haven't started yet.");
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

  it('appends the failed count to the summary', () => {
    renderComplete({ totalFiles: 5, uploadedFiles: 3, chunkedFiles: 3, vectorizedFiles: 3, failedFiles: 2 });
    expect(screen.getByText('3 files uploaded, chunked, and vectorized. 2 failed.')).toBeInTheDocument();
  });
});

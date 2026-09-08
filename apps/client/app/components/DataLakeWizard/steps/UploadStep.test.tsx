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

/**
 * The fileless Drive commit (#1916) shares uploadProgress with the upload path, so this step has to
 * tell them apart: with zero files every counter is 0, and the file-count screens above would read
 * that as "nothing uploaded" - a failure - for what is a successful hand-off to Drive ingest.
 */
describe('UploadStep - Drive-only commit (#1916)', () => {
  afterEach(() => {
    useDataLakeWizardStore.getState().resetWizard();
  });

  function renderDriveCommit(status: UploadProgress['status'], overrides: Partial<UploadProgress> = {}) {
    useDataLakeWizardStore.setState(state => ({
      targetLake: null,
      allFiles: [],
      pendingDriveFolder: { driveFolderId: 'FOLDER1', folderName: 'Contracts' },
      uploadProgress: { ...state.uploadProgress, totalFiles: 0, status, ...overrides },
    }));
    return render(
      <TestWrapper>
        <UploadStep />
      </TestWrapper>
    );
  }

  it('reports the folder it is about to sync while idle', () => {
    renderDriveCommit('idle');
    expect(screen.getByTestId('drive-only-commit-idle')).toHaveTextContent('Contracts');
  });

  it('reports the create + connect in progress, not an upload', () => {
    renderDriveCommit('uploading');
    expect(screen.getByTestId('drive-only-commit-pending')).toBeInTheDocument();
    expect(screen.queryByText(/Uploading files/)).toBeNull();
  });

  it('reads success as a created lake with ingest running, not zero files uploaded', () => {
    renderDriveCommit('complete');
    const complete = screen.getByTestId('drive-only-commit-complete');
    expect(complete).toHaveTextContent('Contracts');
    expect(complete).toHaveTextContent('background');
    expect(screen.queryByText('Upload Complete!')).toBeNull();
  });

  // Pins the word spacing, not just the words. Built from JSX text interleaved with {DATA_LAKE}
  // expressions, this sentence rendered live as "Data Lakeslist" - JSX drops the space between an
  // expression and the text after it, and toHaveTextContent's substring match never saw it.
  it('keeps the spaces around the branded nouns in the syncing sentence', () => {
    renderDriveCommit('complete');
    const text = screen.getByTestId('drive-only-commit-complete').textContent ?? '';
    expect(text).toContain('Files appear in this Data Lake as they are pulled in');
    expect(text).toContain('the Data Lakes list shows');
    expect(text).not.toMatch(/Data Lakes\S/);
  });

  it('surfaces the refusal and says the new lake was rolled back', () => {
    // Matches useCreateLakeFromDrive's rollback: a failed connect archives the lake it created, so
    // the user has nothing to clean up before retrying. Archive, not erase - the copy must not
    // promise a hard delete (verified live: the row survives with status 'archived').
    renderDriveCommit('error', {
      errorMessage: 'This Drive folder is already connected to another data lake',
      driveRollback: 'archived',
    });
    const failed = screen.getByTestId('drive-only-commit-error');
    expect(failed).toHaveTextContent('This Drive folder is already connected to another data lake');
    expect(failed).toHaveTextContent('The new Data Lake was rolled back');
  });

  // The compound failure: connect refused AND the rollback archive itself failed. The lake is still
  // live in the user's list, so claiming it was rolled back would send them off looking for nothing.
  it('does not claim a rollback when the rollback itself failed', () => {
    renderDriveCommit('error', { errorMessage: 'nope', driveRollback: 'failed' });
    const failed = screen.getByTestId('drive-only-commit-error');
    expect(failed).not.toHaveTextContent('The new Data Lake was rolled back');
    expect(failed).toHaveTextContent('may still be in your Data Lakes list');
    expect(failed.textContent ?? '').not.toMatch(/Data Lakes\S/);
  });

  it('claims nothing about a rollback that was never attempted', () => {
    // No driveRollback means no delete ran (e.g. the create itself was refused), so the screen
    // states only the refusal.
    renderDriveCommit('error', { errorMessage: 'nope' });
    const failed = screen.getByTestId('drive-only-commit-error');
    expect(failed).not.toHaveTextContent('rolled back');
    expect(failed).not.toHaveTextContent('may still be in your');
  });

  it('sends a failed commit back to Configure, where the name and prefix can be fixed', () => {
    renderDriveCommit('error', { errorMessage: 'nope' });
    screen.getByText('Back to Configuration').click();
    expect(useDataLakeWizardStore.getState().step).toBe('config');
  });

  it('keeps the file-count screens when files were uploaded alongside a Drive folder', () => {
    // The mixed path is a real upload, so it must keep the upload UI even though a folder is pending.
    renderDriveCommit('complete', { totalFiles: 2, uploadedFiles: 2, chunkedFiles: 2, vectorizedFiles: 2 });
    expect(screen.getByText('Upload Complete!')).toBeInTheDocument();
    expect(screen.queryByTestId('drive-only-commit-complete')).toBeNull();
  });
});

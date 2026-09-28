import type { ReactNode } from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import type { UploadProgress } from '@client/app/stores/useDataLakeWizardStore';
import DataLakeUploadIndicator from './DataLakeUploadIndicator';

/**
 * Batch-completion cache sync used to live in this component (#3234 follow-up), but a later
 * review (#3238) moved it to ProviderBundle - see useDataLakeBatchCompletionSync's own doc
 * comment and ProviderBundle.test.tsx. This file covers only the indicator's own visibility and
 * click behavior.
 */

describe('DataLakeUploadIndicator', () => {
  beforeEach(() => {
    useDataLakeWizardStore.setState({
      isOpen: false,
      uploadProgress: {
        totalFiles: 0,
        uploadedFiles: 0,
        chunkedFiles: 0,
        vectorizedFiles: 0,
        failedFiles: 0,
        failedFileNames: [],
        processingFailedFiles: 0,
        status: 'idle',
        currentBatchId: undefined,
      },
    });
  });

  it('renders nothing when no upload is active or shown', () => {
    const { container } = render(<DataLakeUploadIndicator />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the wizard modal is open, even with an active upload', () => {
    useDataLakeWizardStore.setState({
      isOpen: true,
      uploadProgress: {
        totalFiles: 3,
        uploadedFiles: 1,
        chunkedFiles: 0,
        vectorizedFiles: 0,
        failedFiles: 0,
        failedFileNames: [],
        processingFailedFiles: 0,
        status: 'uploading',
        currentBatchId: 'batch1',
      },
    });

    const { container } = render(<DataLakeUploadIndicator />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows upload progress once the wizard is closed with an upload in flight', () => {
    useDataLakeWizardStore.setState({
      isOpen: false,
      uploadProgress: {
        totalFiles: 4,
        uploadedFiles: 2,
        chunkedFiles: 0,
        vectorizedFiles: 0,
        failedFiles: 0,
        failedFileNames: [],
        processingFailedFiles: 0,
        status: 'uploading',
        currentBatchId: 'batch1',
      },
    });

    render(<DataLakeUploadIndicator />);
    expect(screen.getByTestId('data-lake-upload-indicator')).toHaveTextContent('Uploading... 50%');
    expect(screen.getByTestId('data-lake-upload-indicator')).toHaveTextContent('2 / 4 files');
  });

  it('reopens the wizard on the upload step when clicked', () => {
    useDataLakeWizardStore.setState({
      isOpen: false,
      uploadProgress: {
        totalFiles: 1,
        uploadedFiles: 1,
        chunkedFiles: 0,
        vectorizedFiles: 0,
        failedFiles: 0,
        failedFileNames: [],
        processingFailedFiles: 0,
        status: 'complete',
        currentBatchId: 'batch1',
      },
    });

    render(<DataLakeUploadIndicator />);
    fireEvent.click(screen.getByTestId('data-lake-upload-indicator'));

    const state = useDataLakeWizardStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.step).toBe('upload');
  });
});

/**
 * #3222: this indicator is the surface a user sees after "Close and continue in background", so it
 * reports the upload as finished without the wizard's Complete screen ever being on screen. A green
 * "Upload Complete" here, with the lake still a non-serving draft, is the same false all-clear the
 * Complete screen was giving.
 */

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

/** The indicator only renders while the wizard is closed and a real batch is in flight. */
function renderIndicator(overrides: Partial<UploadProgress>) {
  useDataLakeWizardStore.setState(state => ({
    isOpen: false,
    uploadProgress: { ...state.uploadProgress, totalFiles: 2, uploadedFiles: 2, status: 'complete', ...overrides },
  }));
  return render(
    <TestWrapper>
      <DataLakeUploadIndicator />
    </TestWrapper>
  );
}

describe('DataLakeUploadIndicator - non-serving lake disclosure (#3222)', () => {
  afterEach(() => {
    useDataLakeWizardStore.getState().resetWizard();
  });

  it('flags a completed upload into a draft lake as not searchable', () => {
    renderIndicator({ lakeStatus: 'draft' });
    expect(screen.getByText('Upload Complete')).toBeInTheDocument();
    expect(screen.getByTestId('upload-indicator-not-serving')).toHaveTextContent('Draft - not searchable yet');
  });

  it('stays silent for a lake that already serves retrieval', () => {
    renderIndicator({ lakeStatus: 'active' });
    expect(screen.queryByTestId('upload-indicator-not-serving')).toBeNull();
  });

  it('claims nothing when the status is unknown', () => {
    renderIndicator({});
    expect(screen.queryByTestId('upload-indicator-not-serving')).toBeNull();
  });

  // The warning belongs to the finished state only - during the upload the lake's status is not yet
  // the thing the user is waiting on, and the chip would read as an upload failure.
  it('does not warn while the upload is still running', () => {
    renderIndicator({ status: 'uploading', uploadedFiles: 1, lakeStatus: 'draft' });
    expect(screen.queryByTestId('upload-indicator-not-serving')).toBeNull();
  });

  it('names a non-draft non-serving status rather than calling it a draft', () => {
    renderIndicator({ lakeStatus: 'archived' });
    expect(screen.getByTestId('upload-indicator-not-serving')).toHaveTextContent('Not searchable yet (archived)');
  });
});

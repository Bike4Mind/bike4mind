import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
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

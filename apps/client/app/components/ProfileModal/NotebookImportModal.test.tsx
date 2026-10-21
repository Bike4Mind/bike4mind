import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { apiPost, uploadFileToUrlMock } = vi.hoisted(() => ({
  apiPost: vi.fn(),
  uploadFileToUrlMock: vi.fn(),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: apiPost } }));
vi.mock('@client/app/utils/uploadFileToUrl', () => ({ uploadFileToUrl: uploadFileToUrlMock }));
vi.mock('@client/app/components/help', () => ({ ContextHelpButton: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import NotebookImportModal from './NotebookImportModal';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('NotebookImportModal upload size', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiPost.mockResolvedValue({ data: { success: true, uploadUrl: '/upload', importId: 1 } });
    uploadFileToUrlMock.mockResolvedValue(undefined);
  });

  it('declares the UTF-8 byte length of the exact Blob uploaded for pasted JSON', async () => {
    const json = '{"title":"\u65e5\u672c\u8a9e \u{1f6b2}"}';
    render(
      <CssVarsProvider theme={appTheme}>
        <NotebookImportModal open onClose={vi.fn()} onImport={vi.fn()} />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByTestId('notebook-import-json-tab'));
    fireEvent.change(screen.getByTestId('notebook-import-json-input'), {
      target: { value: json },
    });
    fireEvent.click(screen.getByTestId('notebook-import-submit-btn'));

    await waitFor(() => expect(uploadFileToUrlMock).toHaveBeenCalledTimes(1));
    const uploadedBody = uploadFileToUrlMock.mock.calls[0][1] as Blob;
    expect(uploadedBody.size).toBe(new TextEncoder().encode(json).byteLength);
    expect(uploadedBody.size).toBeGreaterThan(json.length);
    expect(apiPost).toHaveBeenCalledWith('/api/notebooks/import', expect.objectContaining({ size: uploadedBody.size }));
  });
});

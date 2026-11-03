import React, { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { AxiosError, AxiosHeaders } from 'axios';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * "Upload Files > From device" must tell the user why the server refused the file. Runs the real
 * useCreateFabFile against a rejected createFabFile call, through the real UploadDropdown.
 */

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

const createFabFileOnServerWithUpload = vi.fn();
vi.mock('@client/app/utils/filesAPICalls', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/utils/filesAPICalls')>()),
  createFabFileOnServerWithUpload: (...a: unknown[]) => createFabFileOnServerWithUpload(...a),
}));

vi.mock('../../Knowledge/CreateKnowledgeFromUrl', () => ({ default: () => null }));

vi.mock('../../Knowledge/KnowledgeModal', () => {
  const state = { setOpen: vi.fn(), setSelectedFabFileId: vi.fn(), setViewOnly: vi.fn() };
  return { useKnowledgeModal: (selector: (s: typeof state) => unknown) => selector(state) };
});

vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: () => false }),
}));

import { UploadDropdown } from './Content';

const appTheme = extendTheme({ ...getThemeConfig() });

const serverRefusal = (status: number, data: Record<string, unknown>) => {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(
    'Request failed',
    'ERR_BAD_REQUEST',
    config,
    {},
    {
      status,
      statusText: '',
      headers: {},
      config,
      data,
    }
  );
};

function renderDropdown() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(
    <Wrapper>
      <UploadDropdown isLoading={false} />
    </Wrapper>
  );
}

function pickFile(file: File) {
  fireEvent.change(screen.getByTestId('upload-actions-file-input'), { target: { files: [file] } });
}

describe('UploadDropdown - From device server refusal', () => {
  beforeEach(() => {
    toastError.mockReset();
    createFabFileOnServerWithUpload.mockReset();
  });

  it.each([
    [
      400,
      { error: 'File size exceeds maximum file size', errorCode: 'file_too_large' },
      'File size exceeds maximum file size',
    ],
    [400, { name: 'BadRequestError', error: 'File type .exe is not supported' }, 'File type .exe is not supported'],
    [
      429,
      { error: 'Upload limit reached (20 files per hour). Try again in 12 minutes.' },
      'Upload limit reached (20 files per hour). Try again in 12 minutes.',
    ],
  ])('shows the server message for a %s refusal', async (status, data, expected) => {
    createFabFileOnServerWithUpload.mockRejectedValue(serverRefusal(status, data));
    renderDropdown();

    pickFile(new File(['x'], 'big.txt', { type: 'text/plain' }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(expected);
  });
});

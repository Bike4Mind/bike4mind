import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { refreshUserMock, mutateAsyncMock, toastMock } = vi.hoisted(() => ({
  refreshUserMock: vi.fn(),
  mutateAsyncMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}));

type ProcessFn = (
  fieldName: string,
  file: File,
  metadata: Record<string, unknown>,
  load: (fileId: string | number) => void,
  error: (message: string) => void,
  progress: (computable: boolean, loaded: number, total: number) => void
) => Promise<void>;

// Capture the `server.process` FilePond would drive, so the test can run the real
// upload path without mounting the widget or a DOM file input.
let capturedProcess: ProcessFn | null = null;

vi.mock('react-filepond', () => ({
  FilePond: (props: { server?: { process?: ProcessFn } }) => {
    capturedProcess = props.server?.process ?? null;
    return null;
  },
  registerPlugin: vi.fn(),
}));

vi.mock('@client/app/utils/userAPICalls', () => ({
  useUploadProfilePhoto: () => ({ mutateAsync: mutateAsyncMock }),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'user-1' }, refreshUser: refreshUserMock }),
}));

vi.mock('sonner', () => ({ toast: toastMock }));

import UploadProfilePhotoModal from './UploadProfilePhotoModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const FILE = new File(['photo'], 'avatar.png', { type: 'image/png' });

/** Renders the modal and runs one upload through the captured FilePond process hook. */
async function upload() {
  render(
    <Wrapper>
      <UploadProfilePhotoModal open onClose={vi.fn()} onUploadComplete={vi.fn()} />
    </Wrapper>
  );

  expect(capturedProcess).toBeTypeOf('function');

  const load = vi.fn();
  const error = vi.fn();
  await act(async () => {
    await capturedProcess!('files', FILE, {}, load, error, vi.fn());
  });

  return { load, error };
}

describe('UploadProfilePhotoModal', () => {
  beforeEach(() => {
    capturedProcess = null;
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refreshes the zustand user store after a successful upload', async () => {
    mutateAsyncMock.mockResolvedValue('file-1');

    const { load, error } = await upload();

    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('file-1');
    expect(error).not.toHaveBeenCalled();
    // The sidebar avatar reads the user store, which the react-query invalidation does not touch.
    expect(refreshUserMock).toHaveBeenCalledTimes(1);
    expect(refreshUserMock).toHaveBeenCalledWith({ fresh: true });
  });

  it('does not refresh the store when the upload fails', async () => {
    mutateAsyncMock.mockRejectedValue(new Error('boom'));

    const { error } = await upload();

    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(refreshUserMock).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith('Failed to upload profile photo');
    expect(error).toHaveBeenCalledWith('Upload failed');
  });

  it('uploads with the current user id and file metadata', async () => {
    mutateAsyncMock.mockResolvedValue('file-1');

    await upload();

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      userId: 'user-1',
      fileInfo: { fileName: 'avatar.png', fileSize: FILE.size, mimeType: 'image/png' },
      file: FILE,
    });
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ModalVideo } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import AdminModalVideoFields, { normalizeModalVideo } from './AdminModalVideoFields';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  mutateAsync: vi.fn(async ({ filePaths }: { filePaths: string[] }) => filePaths.map(p => `https://signed.test/${p}`)),
  toastError: vi.fn(),
}));

vi.mock('@client/app/utils/filesAPICalls', () => ({ createFabFileOnServerWithUpload: mocks.upload }));
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetPresignedUrl: () => ({ mutateAsync: mocks.mutateAsync }),
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderFields = (value: ModalVideo | null, onChange = vi.fn()) => {
  render(
    <CssVarsProvider theme={appTheme}>
      <AdminModalVideoFields value={value} onChange={onChange} bucketName="fab-bucket" />
    </CssVarsProvider>
  );
  return onChange;
};

const file = (name: string, type: string) => new File(['x'], name, { type });

describe('AdminModalVideoFields', () => {
  beforeEach(() => {
    mocks.upload.mockReset();
    mocks.toastError.mockReset();
  });

  it('uploads a 16:9 mp4 publicly under the modals prefix and stores its S3 url', async () => {
    mocks.upload.mockResolvedValue({ id: 'f1', filePath: 'modals/u1/demo.mp4' });
    const onChange = renderFields(null);

    fireEvent.change(screen.getByTestId('modal-video-landscape-video-file-input'), {
      target: { files: [file('demo.mp4', 'video/mp4')] },
    });

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        landscapeUrl: 'https://fab-bucket.s3.us-east-2.amazonaws.com/modals/u1/demo.mp4',
        landscapePosterUrl: null,
        portraitUrl: null,
        portraitPosterUrl: null,
      })
    );
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({ public: true, prefix: 'modals', mimeType: 'video/mp4' }),
      expect.any(File)
    );
  });

  it('rejects a non-mp4 video and a non-image poster', () => {
    const onChange = renderFields(null);

    fireEvent.change(screen.getByTestId('modal-video-portrait-video-file-input'), {
      target: { files: [file('clip.mov', 'video/quicktime')] },
    });
    fireEvent.change(screen.getByTestId('modal-video-portrait-poster-file-input'), {
      target: { files: [file('poster.mp4', 'video/mp4')] },
    });

    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('accepts a pasted url and previews it', async () => {
    const onChange = renderFields({ portraitUrl: 'https://cdn.example.com/tall.mp4' });

    expect(await screen.findByTestId('modal-video-portrait-video-preview')).toBeTruthy();

    fireEvent.change(screen.getByTestId('modal-video-landscape-poster-input'), {
      target: { value: 'https://cdn.example.com/wide.png' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      landscapeUrl: null,
      landscapePosterUrl: 'https://cdn.example.com/wide.png',
      portraitUrl: 'https://cdn.example.com/tall.mp4',
      portraitPosterUrl: null,
    });
  });

  it('clears to null once the last slot is emptied', () => {
    const onChange = renderFields({ landscapeUrl: 'https://cdn.example.com/wide.mp4' });
    fireEvent.click(screen.getByTestId('modal-video-landscape-video-clear-btn'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe('normalizeModalVideo', () => {
  it('trims and nulls empty slots', () => {
    expect(normalizeModalVideo({ landscapeUrl: '  https://x.test/a.mp4 ', portraitUrl: '' })).toEqual({
      landscapeUrl: 'https://x.test/a.mp4',
      landscapePosterUrl: null,
      portraitUrl: null,
      portraitPosterUrl: null,
    });
    expect(normalizeModalVideo({ landscapeUrl: ' ' })).toBeNull();
  });
});

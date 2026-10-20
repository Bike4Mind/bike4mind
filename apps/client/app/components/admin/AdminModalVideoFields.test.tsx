// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { MODAL_MEDIA_URL_HINT, type ModalVideo } from '@bike4mind/common';
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

// Feeds onChange back into value, like the editor does
const renderStateful = (initial: ModalVideo | null) => {
  let value = initial;
  const ui = () => (
    <CssVarsProvider theme={appTheme}>
      <AdminModalVideoFields
        value={value}
        onChange={next => {
          value = next;
        }}
        bucketName="fab-bucket"
      />
    </CssVarsProvider>
  );
  const view = render(ui());
  return { rerender: () => view.rerender(ui()) };
};

const file = (name: string, type: string) => new File(['x'], name, { type });

describe('AdminModalVideoFields', () => {
  beforeEach(() => {
    mocks.upload.mockReset();
    mocks.toastError.mockReset();
    mocks.mutateAsync.mockClear();
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

  it('accepts a pasted url and previews the stored one', async () => {
    const onChange = renderFields({ portraitUrl: 'https://d111.cloudfront.net/tall.mp4' });

    expect(await screen.findByTestId('modal-video-portrait-video-preview')).toBeTruthy();

    fireEvent.change(screen.getByTestId('modal-video-landscape-video-input'), {
      target: { value: 'https://d111.cloudfront.net/wide.mp4' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      landscapeUrl: 'https://d111.cloudfront.net/wide.mp4',
      landscapePosterUrl: null,
      portraitUrl: 'https://d111.cloudfront.net/tall.mp4',
      portraitPosterUrl: null,
    });
  });

  it('signs a pasted S3 url for preview on blur, not per keystroke', async () => {
    const url = 'https://fab-bucket.s3.us-east-2.amazonaws.com/modals/wide.mp4';
    const { rerender } = renderStateful(null);
    const input = screen.getByTestId('modal-video-landscape-video-input');

    fireEvent.change(input, { target: { value: url.slice(0, 30) } });
    fireEvent.change(input, { target: { value: url } });
    rerender();
    expect(mocks.mutateAsync).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(await screen.findByTestId('modal-video-landscape-video-preview')).toBeTruthy();
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ filePaths: ['modals/wide.mp4'] }));
  });

  it('shows an inline error for a host the CSP does not allow', () => {
    renderFields({ landscapeUrl: 'https://cdn.example.com/wide.mp4' });
    expect(screen.getByTestId('modal-video-landscape-video-error').textContent).toBe(MODAL_MEDIA_URL_HINT);
  });

  it('shows an inline error for a poster without its video', () => {
    renderFields({ portraitPosterUrl: 'https://d111.cloudfront.net/tall.png' });
    expect(screen.getByTestId('modal-video-portrait-poster-error').textContent).toBe(
      'A 9:16 poster needs its 9:16 video'
    );
  });

  it('names the size limit when the server refuses an oversized upload', async () => {
    mocks.upload.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: {
          status: 400,
          data: {
            error: 'File size exceeds maximum file size',
            errorCode: 'file_too_large',
            used_bytes: 0,
            limit_bytes: 100_000_000,
            requested_bytes: 200_000_000,
            owner: 'user',
          },
        },
      })
    );
    renderFields(null);

    fireEvent.change(screen.getByTestId('modal-video-landscape-video-file-input'), {
      target: { files: [file('big.mp4', 'video/mp4')] },
    });

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('File is too large: uploads are limited to 100 MB')
    );
  });

  it('clears to null once the last slot is emptied', () => {
    const onChange = renderFields({ landscapeUrl: 'https://d111.cloudfront.net/wide.mp4' });
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

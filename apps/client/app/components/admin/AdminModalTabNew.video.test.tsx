// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IModal } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import EditModalNew from './AdminModalTabNew';

vi.mock('react-filepond', () => ({ FilePond: () => <div /> }));
vi.mock('@client/app/components/modals/GenericModal', () => ({ default: () => null }));
vi.mock('@client/app/utils/filesAPICalls', () => ({ createFabFileOnServerWithUpload: vi.fn() }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useConfig: () => ({ data: { fabfileBucketName: 'fab-bucket' } }),
}));
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetPresignedUrl: () => ({ mutateAsync: vi.fn(async ({ filePaths }: { filePaths: string[] }) => filePaths) }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });

const existing: IModal = {
  _id: 'm1',
  title: 'Canvas',
  subtitle: null,
  description: 'Draw your model',
  isBanner: false,
  tags: ['whats-new'],
  priority: 0,
  closeButton: true,
  agreeButton: false,
  enabled: true,
  startDate: '2026-10-01',
  endDate: '2026-10-31',
  numberOfAgrees: { type: 'firstTimeAgree', value: 0, threshold: 1 },
  numberOfViews: { type: 'firstTimeView', value: 0, threshold: 1 },
  imageUrl: null,
  textMessage: null,
  video: { portraitUrl: 'https://d111.cloudfront.net/tall.mp4' },
};

const renderEditor = (modalData: IModal, onSave = vi.fn()) => {
  render(
    <CssVarsProvider theme={appTheme}>
      <EditModalNew isOpen onClose={vi.fn()} modalData={modalData} onSave={onSave} isEditMode />
    </CssVarsProvider>
  );
  return onSave;
};

const next = () => fireEvent.click(screen.getByRole('button', { name: /^Next/ }));

describe('EditModalNew video', () => {
  it('blocks leaving the media step while a video url is invalid', () => {
    renderEditor(existing);
    next(); // content
    next(); // media
    fireEvent.change(screen.getByTestId('modal-video-landscape-video-input'), {
      target: { value: 'https://cdn.example.com/wide.mp4' },
    });
    next();

    expect(screen.getByTestId('modal-video-step-error')).toBeTruthy();
    expect(screen.getByTestId('modal-video-landscape-video-input')).toBeTruthy();
  });

  it('drops the video when the modal is saved as a banner', () => {
    const onSave = renderEditor({ ...existing, isBanner: true, textMessage: 'Banner text' });
    for (let i = 0; i < 5; i++) next();
    fireEvent.click(screen.getByRole('button', { name: /Update Banner/ }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ isBanner: true, video: null }));
  });

  it('saves a pasted 16:9 url alongside the stored 9:16 one', () => {
    const onSave = renderEditor(existing);
    next(); // content
    next(); // media
    fireEvent.change(screen.getByTestId('modal-video-landscape-video-input'), {
      target: { value: 'https://d111.cloudfront.net/wide.mp4' },
    });
    next(); // targeting
    next(); // behavior
    next(); // review
    expect(screen.getByTestId('modal-review-video-text').textContent).toBe('16:9 + 9:16');
    fireEvent.click(screen.getByRole('button', { name: /Update Modal/ }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        video: {
          landscapeUrl: 'https://d111.cloudfront.net/wide.mp4',
          landscapePosterUrl: null,
          portraitUrl: 'https://d111.cloudfront.net/tall.mp4',
          portraitPosterUrl: null,
        },
      })
    );
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

const renderEditor = (modalData: IModal, onSave = vi.fn(), onClose = vi.fn(), isEditMode = true) => {
  render(
    <CssVarsProvider theme={appTheme}>
      <EditModalNew isOpen onClose={onClose} modalData={modalData} onSave={onSave} isEditMode={isEditMode} />
    </CssVarsProvider>
  );
  return onSave;
};

const clickButton = (label: string) => fireEvent.click(screen.getByText(label, { selector: 'button' }));
const next = () => fireEvent.click(screen.getByTestId('admin-modal-wizard-next-btn'));
const back = () => fireEvent.click(screen.getByTestId('admin-modal-wizard-back-btn'));

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

  it('accepts a stored self-host video url it was loaded with', () => {
    const minioUrl = 'http://localhost:9000/fab-bucket/modals/u1/tall.mp4';
    const onSave = renderEditor({ ...existing, video: { portraitUrl: minioUrl } });
    for (let i = 0; i < 5; i++) next();
    clickButton('Update modal');

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ video: { portraitUrl: minioUrl } }));
  });

  it('drops the video when the modal is saved as a banner', () => {
    const onSave = renderEditor({ ...existing, isBanner: true, textMessage: 'Banner text' });
    for (let i = 0; i < 5; i++) next();
    clickButton('Update banner');

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
    clickButton('Update modal');

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

describe('EditModalNew wizard', () => {
  it('steps forward and back through the dialog', () => {
    renderEditor(existing);
    expect(screen.getByTestId('admin-modal-wizard-dialog')).toBeTruthy();
    expect(screen.getByTestId('admin-modal-wizard-back-btn').hasAttribute('disabled')).toBe(true);
    next();
    expect(screen.getByText('Modal content')).toBeTruthy();
    back();
    expect(screen.getByText('What would you like to create?')).toBeTruthy();
  });

  it('switches to the banner steps from the type control', () => {
    renderEditor({ ...existing, video: null }, vi.fn(), vi.fn(), false);
    expect(screen.getByText('Create modal', { selector: 'h2' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('admin-modal-wizard-type-banner'));
    expect(screen.getByText('Create banner', { selector: 'h2' })).toBeTruthy();
    expect(screen.getByText('Message')).toBeTruthy();
    next();
    expect(screen.getByText('Banner notification')).toBeTruthy();
  });

  it('calls onClose from the close button and from Cancel', () => {
    const onClose = vi.fn();
    renderEditor(existing, vi.fn(), onClose);
    fireEvent.click(screen.getByTestId('admin-modal-wizard-dialog-close-btn'));
    fireEvent.click(screen.getByTestId('admin-modal-wizard-cancel-btn'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('leaves closing to the caller, so a failed save keeps the draft open', async () => {
    const onClose = vi.fn();
    // The parent toasts a failed save and resolves without closing.
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor(existing, onSave, onClose);
    for (let i = 0; i < 5; i++) next();
    clickButton('Update modal');
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('admin-modal-wizard-save-btn')).not.toBeDisabled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('admin-modal-wizard-dialog')).toBeTruthy();
  });

  it('asks before discarding an edited draft and keeps it on Keep editing', () => {
    const onClose = vi.fn();
    renderEditor(existing, vi.fn(), onClose);
    fireEvent.click(screen.getByTestId('admin-modal-wizard-type-banner'));
    fireEvent.click(screen.getByTestId('admin-modal-wizard-cancel-btn'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('admin-modal-wizard-keep-btn'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Message')).toBeTruthy();
    fireEvent.click(screen.getByTestId('admin-modal-wizard-cancel-btn'));
    fireEvent.click(screen.getByTestId('admin-modal-wizard-discard-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores a backdrop click but closes on Escape', () => {
    const onClose = vi.fn();
    renderEditor(existing, vi.fn(), onClose);
    const dialog = screen.getByTestId('admin-modal-wizard-dialog');
    const backdrop = dialog.closest('.MuiModal-root')?.querySelector('.MuiModal-backdrop');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

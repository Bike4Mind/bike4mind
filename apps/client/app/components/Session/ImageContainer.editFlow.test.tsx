import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';

const h = vi.hoisted(() => ({
  createFabFileOnServerWithUpload: vi.fn(),
  moderateFabFileNow: vi.fn(),
  deleteFileUtility: vi.fn(),
  copyGeneratedImageToFabFile: vi.fn(),
  toastError: vi.fn(),
  studioImageEnabled: false,
  openStudioImageEdit: vi.fn(),
}));

vi.mock('@client/app/components/Studio/useStudioFeature', () => ({
  useStudioFeature: () => h.studioImageEnabled,
}));
vi.mock('@client/app/components/ImageStudio/useOpenStudioImageEdit', () => ({
  useOpenStudioImageEdit: () => h.openStudioImageEdit,
}));

vi.mock('sonner', () => ({ toast: { error: h.toastError, success: vi.fn() } }));

vi.mock('@client/app/utils/filesAPICalls', () => ({
  createFabFileOnServerWithUpload: h.createFabFileOnServerWithUpload,
  moderateFabFileNow: h.moderateFabFileNow,
  deleteFileUtility: h.deleteFileUtility,
  copyGeneratedImageToFabFile: h.copyGeneratedImageToFabFile,
}));
vi.mock('./ImageMaskerFlux', () => ({
  default: ({ onSave }: { onSave: (url: string, mask: string, prompt: string) => void }) => (
    <button
      data-testid="stub-masker-save"
      onClick={() => onSave('https://example.com/image.png', btoa('mask'), 'make it blue')}
    />
  ),
}));

import ImageContainer from './ImageContainer';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('ImageContainer edit flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.studioImageEnabled = false;
    h.createFabFileOnServerWithUpload.mockResolvedValue({ id: 'mask1' });
    h.moderateFabFileNow.mockResolvedValue('clean');
  });

  const renderAndSave = async (onSendMessage: ReturnType<typeof vi.fn>) => {
    render(
      <CssVarsProvider theme={appTheme}>
        <ImageContainer
          index={0}
          totalImages={1}
          images={['https://example.com/image.png']}
          src="https://example.com/image.png"
          onSendMessage={onSendMessage}
        />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getAllByTestId('image-edit-btn')[0]);
    fireEvent.click(await screen.findByTestId('stub-masker-save'));
  };

  it('scans the mask before dispatching the edit', async () => {
    const onSendMessage = vi.fn(async () => {});
    await renderAndSave(onSendMessage);
    await waitFor(() => expect(onSendMessage).toHaveBeenCalled());

    expect(h.moderateFabFileNow).toHaveBeenCalledWith('mask1');
    expect(h.moderateFabFileNow.mock.invocationCallOrder[0]).toBeLessThan(onSendMessage.mock.invocationCallOrder[0]);
    expect(onSendMessage).toHaveBeenCalledWith(
      { fabFileIds: ['mask1'], prompt: 'make it blue' },
      expect.objectContaining({ isImageEdit: true })
    );
  });

  it('passes the file behind the shown image along with the edit', async () => {
    const onSendMessage = vi.fn(async () => {});
    render(
      <CssVarsProvider theme={appTheme}>
        <ImageContainer
          id="file-behind"
          index={0}
          totalImages={1}
          images={['https://example.com/image.png']}
          src="https://example.com/image.png"
          onSendMessage={onSendMessage}
        />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getAllByTestId('image-edit-btn')[0]);
    fireEvent.click(await screen.findByTestId('stub-masker-save'));

    await waitFor(() => expect(onSendMessage).toHaveBeenCalled());
    expect(onSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isImageEdit: true, imageFileId: 'file-behind' })
    );
  });

  // An image job refuses an input that is not 'clean', so a still-pending mask is not sent (uploadEditMask).
  it('stops, and removes the mask, when the scan reports pending', async () => {
    h.moderateFabFileNow.mockResolvedValue('pending');
    const onSendMessage = vi.fn(async () => {});
    await renderAndSave(onSendMessage);

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining('could not be checked')));
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(h.deleteFileUtility).toHaveBeenCalledWith('mask1');
  });

  it('stops with an error toast, without dispatching, when the scan reports blocked', async () => {
    h.moderateFabFileNow.mockResolvedValue('blocked');
    const onSendMessage = vi.fn(async () => {});
    await renderAndSave(onSendMessage);

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining('blocked by moderation')));
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(h.deleteFileUtility).toHaveBeenCalledWith('mask1');
  });

  describe('with Studio image open', () => {
    const GENERATED = 'https://generatedimagesbucket.s3.amazonaws.com/abc123.png?X-Amz-Signature=x';
    const renderImage = (src: string) =>
      render(
        <CssVarsProvider theme={appTheme}>
          <ImageContainer index={0} totalImages={1} images={[src]} src={src} onSendMessage={vi.fn()} />
        </CssVarsProvider>
      );

    beforeEach(() => {
      h.studioImageEnabled = true;
      h.copyGeneratedImageToFabFile.mockResolvedValue({ id: 'file1', fileName: 'image_1.png', created: true });
    });

    it('saves a generated image to Files, scans it, and opens it in Studio edit mode', async () => {
      renderImage(GENERATED);
      fireEvent.click(screen.getAllByTestId('image-edit-btn')[0]);
      await waitFor(() => expect(h.openStudioImageEdit).toHaveBeenCalled());

      expect(h.copyGeneratedImageToFabFile).toHaveBeenCalledWith('abc123.png', expect.any(String));
      expect(h.moderateFabFileNow).toHaveBeenCalledWith('file1');
      expect(h.openStudioImageEdit).toHaveBeenCalledWith({ fileId: 'file1', fileName: 'image_1.png' });
      expect(screen.queryByTestId('stub-masker-save')).toBeNull();
    });

    it('does not open Studio when the copy is blocked by moderation', async () => {
      h.moderateFabFileNow.mockResolvedValue('blocked');
      renderImage(GENERATED);
      fireEvent.click(screen.getAllByTestId('image-edit-btn')[0]);
      await waitFor(() => expect(h.toastError).toHaveBeenCalled());
      expect(h.openStudioImageEdit).not.toHaveBeenCalled();
      expect(h.deleteFileUtility).toHaveBeenCalledWith('file1');
    });

    it('keeps the caller earlier copy when it scans blocked', async () => {
      h.copyGeneratedImageToFabFile.mockResolvedValue({ id: 'file1', fileName: 'image_1.png', created: false });
      h.moderateFabFileNow.mockResolvedValue('blocked');
      renderImage(GENERATED);
      fireEvent.click(screen.getAllByTestId('image-edit-btn')[0]);
      await waitFor(() => expect(h.toastError).toHaveBeenCalled());
      expect(h.deleteFileUtility).not.toHaveBeenCalled();
    });

    it('keeps the in-chat masker for an image that is not a generated one', async () => {
      renderImage('https://example.com/image.png');
      fireEvent.click(screen.getAllByTestId('image-edit-btn')[0]);
      expect(await screen.findByTestId('stub-masker-save')).toBeInTheDocument();
      expect(h.copyGeneratedImageToFabFile).not.toHaveBeenCalled();
    });
  });
});

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';

const h = vi.hoisted(() => ({
  createFabFileOnServerWithUpload: vi.fn(),
  moderateFabFileNow: vi.fn(),
}));

vi.mock('@client/app/utils/filesAPICalls', () => ({
  createFabFileOnServerWithUpload: h.createFabFileOnServerWithUpload,
  moderateFabFileNow: h.moderateFabFileNow,
  copyGeneratedImageToFabFile: vi.fn(),
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
    await waitFor(() => expect(onSendMessage).toHaveBeenCalled());
  };

  it('scans the mask before dispatching the edit', async () => {
    const onSendMessage = vi.fn(async () => {});
    await renderAndSave(onSendMessage);

    expect(h.moderateFabFileNow).toHaveBeenCalledWith('mask1');
    expect(h.moderateFabFileNow.mock.invocationCallOrder[0]).toBeLessThan(onSendMessage.mock.invocationCallOrder[0]);
    expect(onSendMessage).toHaveBeenCalledWith(
      { fabFileIds: ['mask1'], prompt: 'make it blue' },
      expect.objectContaining({ isImageEdit: true })
    );
  });

  it.each(['pending', 'blocked'])(
    'still dispatches when the scan reports %s, leaving the server gate to decide',
    async status => {
      h.moderateFabFileNow.mockResolvedValue(status);
      const onSendMessage = vi.fn(async () => {});
      await renderAndSave(onSendMessage);

      expect(onSendMessage).toHaveBeenCalledTimes(1);
    }
  );
});

import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import ImageBrowserModal from './ImageBrowserModal';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderModal = (extra: { title?: string; emptyHint?: string } = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ImageBrowserModal
        isOpen
        onClose={vi.fn()}
        imageSearch=""
        onImageSearchChange={vi.fn()}
        isLoadingImages={false}
        imageFiles={[]}
        selectedImage={null}
        onSelectImage={vi.fn()}
        onApplyImage={vi.fn()}
        onSearch={vi.fn()}
        {...extra}
      />
    </CssVarsProvider>
  );

describe('ImageBrowserModal', () => {
  it('keeps the portrait wording by default', () => {
    renderModal();
    expect(screen.getByTestId('image-browser-modal-title')).toHaveTextContent('Select Portrait Image');
    expect(screen.getByTestId('image-browser-modal-empty-hint')).toHaveTextContent(/agent portraits/);
  });

  it('takes a caller title and empty hint', () => {
    renderModal({ title: 'Choose an image to animate', emptyHint: 'Upload images in Files to animate them here.' });
    expect(screen.getByTestId('image-browser-modal-title')).toHaveTextContent('Choose an image to animate');
    expect(screen.getByTestId('image-browser-modal-empty-hint')).toHaveTextContent(
      'Upload images in Files to animate them here.'
    );
    expect(screen.queryByText('Select Portrait Image')).not.toBeInTheDocument();
  });
});

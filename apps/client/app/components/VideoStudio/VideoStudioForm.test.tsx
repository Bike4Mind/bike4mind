import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IFabFileDocument, VideoModel } from '@bike4mind/common';
import { estimateVideoCostCredits, VIDEO_MODEL_CATALOG } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { formatCredits } from '@client/app/utils/formatUsd';

const h = vi.hoisted(() => ({ openImageBrowser: vi.fn(), closeImageBrowser: vi.fn() }));

vi.mock('@client/app/hooks/agent/useImageBrowser', () => ({
  useImageBrowser: () => ({
    isImageBrowserOpen: true,
    imageFiles: [],
    isLoadingImages: false,
    selectedImage: null,
    imageSearch: '',
    setImageSearch: vi.fn(),
    openImageBrowser: h.openImageBrowser,
    closeImageBrowser: h.closeImageBrowser,
    selectImage: vi.fn(),
    applySelectedImage: vi.fn(),
    fetchImageFiles: vi.fn(),
  }),
}));
// The real modal is covered by its own test; here it only needs to hand an image back.
vi.mock('@client/app/components/Agent/ImageBrowserModal', () => ({
  default: ({ onApplyImage }: { onApplyImage: (file: IFabFileDocument) => void }) => (
    <button
      data-testid="mock-apply-image"
      onClick={() => onApplyImage({ id: 'img-1', fileName: 'harbor.png' } as IFabFileDocument)}
    />
  ),
}));

import { discreteModel, optionalAudioModel, rangeModel } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import VideoStudioForm from './VideoStudioForm';

const appTheme = extendTheme({ ...getThemeConfig() });
const onSubmit = vi.fn();

const tree = (models: VideoModel[]) => (
  <CssVarsProvider theme={appTheme}>
    <VideoStudioForm models={models} isSubmitting={false} onSubmit={onSubmit} />
  </CssVarsProvider>
);

const pickModel = (name: string) => {
  fireEvent.click(screen.getByTestId('video-form-model-select'));
  fireEvent.click(screen.getByRole('option', { name }));
};
const typePrompt = (text: string) =>
  fireEvent.change(screen.getByTestId('video-form-prompt-input'), { target: { value: text } });
const grokEstimate = (durationSeconds: number) =>
  formatCredits(
    estimateVideoCostCredits(VIDEO_MODEL_CATALOG['grok-imagine-video-1.5'], {
      model: 'grok-imagine-video-1.5',
      mode: 'text_to_video',
      prompt: '',
      durationSeconds,
      aspectRatio: '16:9',
      resolution: '480p',
    })
  );

beforeEach(() => vi.clearAllMocks());

describe('VideoStudioForm duration control', () => {
  it('renders a slider bounded by a range model', () => {
    render(tree([rangeModel]));
    const slider = screen.getByTestId('video-form-duration-slider');
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', '15');
    expect(screen.queryByTestId('video-form-duration-option-4')).not.toBeInTheDocument();
  });

  it('renders one choice per value for a discrete model', () => {
    render(tree([discreteModel]));
    expect(screen.queryByTestId('video-form-duration-slider')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('video-form-duration-option-8'));
    expect(screen.getByTestId('video-form-duration-option-8')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('video-form-duration-option-4')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('VideoStudioForm model switch', () => {
  it('clamps the duration and says what changed', () => {
    render(tree([discreteModel, optionalAudioModel]));
    fireEvent.click(screen.getByTestId('video-form-duration-option-8'));
    pickModel('Synthetic Optional Audio');
    expect(screen.getByTestId('video-form-changes')).toHaveTextContent('Duration changed from 8s to 6s.');
    expect(screen.getByTestId('video-form-duration-slider')).toHaveValue('6');
  });

  it('shows the audio switch only where audio is optional', () => {
    render(tree([discreteModel, optionalAudioModel]));
    expect(screen.queryByTestId('video-form-audio-switch')).not.toBeInTheDocument();
    expect(screen.getByTestId('video-form-audio-note')).toHaveTextContent('Audio is included.');
    pickModel('Synthetic Optional Audio');
    expect(screen.getByTestId('video-form-audio-switch')).toBeChecked();
  });

  it('switches to an offered model when the selected one disappears', () => {
    const { rerender } = render(tree([rangeModel, discreteModel]));
    pickModel('Veo 3.1 Fast');
    rerender(tree([rangeModel]));
    expect(screen.getByTestId('video-form-changes')).toHaveTextContent(
      'The selected model is no longer available; switched to Grok Imagine Video 1.5.'
    );
    typePrompt('a lighthouse');
    fireEvent.click(screen.getByTestId('video-form-submit-btn'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ model: 'grok-imagine-video-1.5' }));
  });
});

describe('VideoStudioForm estimate', () => {
  it('shows the catalog estimate and follows the duration', () => {
    render(tree([rangeModel]));
    expect(screen.getByTestId('video-form-estimate')).toHaveTextContent(`Estimated cost: ${grokEstimate(6)} credits`);
    fireEvent.change(screen.getByTestId('video-form-duration-slider'), { target: { value: '10' } });
    expect(screen.getByTestId('video-form-estimate')).toHaveTextContent(`Estimated cost: ${grokEstimate(10)} credits`);
  });

  it('says when no estimate is available', () => {
    render(tree([optionalAudioModel]));
    expect(screen.getByTestId('video-form-estimate')).toHaveTextContent('Cost estimate unavailable');
  });
});

describe('VideoStudioForm submit', () => {
  it('is disabled until there is a prompt, then sends the body', () => {
    render(tree([rangeModel]));
    expect(screen.getByTestId('video-form-submit-btn')).toBeDisabled();
    typePrompt('  a lighthouse at dusk ');
    fireEvent.click(screen.getByTestId('video-form-submit-btn'));
    expect(onSubmit).toHaveBeenCalledWith({
      model: 'grok-imagine-video-1.5',
      prompt: 'a lighthouse at dusk',
      mode: 'text_to_video',
      duration_seconds: 6,
      aspect_ratio: '16:9',
      resolution: '480p',
    });
  });

  it('needs an image in image to video and sends it', () => {
    render(tree([rangeModel]));
    typePrompt('make the waves move');
    fireEvent.click(within(screen.getByTestId('video-form-mode-toggle')).getByText('Image to video'));
    expect(screen.getByTestId('video-form-submit-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('video-form-image-pick-btn'));
    expect(h.openImageBrowser).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mock-apply-image'));
    expect(screen.getByTestId('video-form-image-name')).toHaveTextContent('harbor.png');
    fireEvent.click(screen.getByTestId('video-form-submit-btn'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'image_to_video', input_image_file_id: 'img-1' })
    );
  });
});

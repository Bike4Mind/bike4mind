import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

// The picker modal and its file search are the Agent's; the form only opens it and takes the applied file.
const h = vi.hoisted(() => ({
  openImageBrowser: vi.fn(),
  applyImage: undefined as undefined | ((file: { id: string; fileName: string }) => void),
}));
vi.mock('@client/app/hooks/agent/useImageBrowser', () => ({
  useImageBrowser: () => ({
    isImageBrowserOpen: false,
    openImageBrowser: h.openImageBrowser,
    closeImageBrowser: vi.fn(),
    imageSearch: '',
    setImageSearch: vi.fn(),
    isLoadingImages: false,
    imageFiles: [],
    selectedImage: null,
    selectImage: vi.fn(),
    fetchImageFiles: vi.fn(),
  }),
}));
vi.mock('@client/app/components/Agent/ImageBrowserModal', () => ({
  default: ({ onApplyImage }: { onApplyImage: (file: { id: string; fileName: string }) => void }) => {
    h.applyImage = onApplyImage;
    return null;
  },
}));

import ImageStudioForm from './ImageStudioForm';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

type Models = Parameters<typeof ImageStudioForm>[0]['models'];
const models: Models = [
  { id: ImageModels.FLUX_KONTEXT_PRO, name: 'FLUX Kontext Pro' },
  { id: ImageModels.FLUX_PRO_ULTRA, name: 'FLUX Ultra' },
  { id: ImageModels.GEMINI_3_1_FLASH_IMAGE, name: 'Nano Banana 2' },
  { id: ImageModels.GPT_IMAGE_1_5, name: 'GPT Image 1.5' },
];

const renderForm = (overrides: Partial<Parameters<typeof ImageStudioForm>[0]> = {}) => {
  const onSubmit = vi.fn();
  render(
    <TestWrapper>
      <ImageStudioForm models={models} isSubmitting={false} onSubmit={onSubmit} {...overrides} />
    </TestWrapper>
  );
  return { onSubmit };
};

const typePrompt = (value: string) =>
  fireEvent.change(screen.getByTestId('image-form-prompt-input'), { target: { value } });
const card = (model: ImageModels) => screen.getByTestId(`image-form-model-card-${model}`);
const pickCard = (model: ImageModels) => fireEvent.click(screen.getByTestId(`image-form-model-card-${model}-radio`));
const submitButton = () => screen.getByTestId('image-form-submit-btn');

describe('ImageStudioForm', () => {
  it('opens on a visible default card and keeps Generate off until there is a prompt', () => {
    renderForm();
    expect(card(ImageModels.GPT_IMAGE_1_5)).toHaveAttribute('data-selected', 'true');
    expect(card(ImageModels.GPT_IMAGE_1_5)).toHaveTextContent('OpenAI');
    expect(screen.getByTestId(`image-form-model-card-${ImageModels.GPT_IMAGE_1_5}-cost`)).toHaveTextContent(
      /credits per image/
    );
    expect(submitButton()).toBeDisabled();
  });

  it('submits the prompt, the model and "make N"', () => {
    const { onSubmit } = renderForm();
    typePrompt('  a red fox in snow  ');
    fireEvent.click(screen.getByTestId('image-form-count-3-btn'));
    expect(submitButton()).toHaveTextContent('Generate 3 images');
    fireEvent.click(submitButton());
    expect(onSubmit).toHaveBeenCalledWith({
      count: 3,
      request: { model: ImageModels.GPT_IMAGE_1_5, mode: 'generate', prompt: 'a red fox in snow' },
    });
  });

  it('makes edit-only and not-yet-wired models unpickable, with the reason on the card', () => {
    renderForm();
    expect(screen.getByTestId(`image-form-model-card-${ImageModels.FLUX_KONTEXT_PRO}-radio`)).toBeDisabled();
    expect(
      screen.getByTestId(`image-form-model-card-${ImageModels.FLUX_KONTEXT_PRO}-reason`)
    ).not.toBeEmptyDOMElement();
    expect(screen.getByTestId(`image-form-model-card-${ImageModels.FLUX_PRO_ULTRA}-reason`)).toHaveTextContent(
      'Temporarily unavailable'
    );
  });

  it('sends a chosen quality, and greys the models that cannot honour them', () => {
    const { onSubmit } = renderForm();
    fireEvent.click(screen.getByTestId('image-form-quality-high-btn'));
    expect(
      screen.getByTestId(`image-form-model-card-${ImageModels.GEMINI_3_1_FLASH_IMAGE}-reason`)
    ).toBeInTheDocument();
    typePrompt('tall poster');
    fireEvent.click(submitButton());
    expect(onSubmit).toHaveBeenCalledWith({
      count: 1,
      request: { model: ImageModels.GPT_IMAGE_1_5, mode: 'generate', prompt: 'tall poster', quality: 'high' },
    });
  });

  it('keeps a value the new model does not take, marks it with the reason, and holds Generate until it is fixed', () => {
    const { onSubmit } = renderForm();
    fireEvent.click(screen.getByTestId('image-form-quality-high-btn'));
    typePrompt('a lighthouse');
    pickCard(ImageModels.GEMINI_3_1_FLASH_IMAGE);

    expect(card(ImageModels.GEMINI_3_1_FLASH_IMAGE)).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('image-form-quality-high-btn')).toHaveAttribute('data-invalid', 'true');
    expect(screen.getByTestId('image-form-quality-invalid')).not.toBeEmptyDOMElement();
    expect(submitButton()).toBeDisabled();

    fireEvent.click(screen.getByTestId('image-form-quality-fix-btn'));
    expect(screen.queryByTestId('image-form-quality-toggle')).not.toBeInTheDocument();
    fireEvent.click(submitButton());
    expect(onSubmit).toHaveBeenCalledWith({
      count: 1,
      request: { model: ImageModels.GEMINI_3_1_FLASH_IMAGE, mode: 'generate', prompt: 'a lighthouse' },
    });
  });

  it('hides the settings a model does not offer', () => {
    renderForm({ models: [{ id: ImageModels.GEMINI_3_1_FLASH_IMAGE, name: 'Nano Banana 2' }] });
    expect(screen.queryByTestId('image-form-size-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('image-form-aspect-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('image-form-quality-toggle')).not.toBeInTheDocument();
    expect(screen.getByTestId('image-form-references-add-btn')).toBeInTheDocument();
  });

  it('opens the picker from the reference slot', () => {
    renderForm();
    fireEvent.click(screen.getByTestId('image-form-references-add-btn'));
    expect(h.openImageBrowser).toHaveBeenCalled();
  });

  it('sends an applied reference image as a reference input', () => {
    const { onSubmit } = renderForm();
    act(() => h.applyImage?.({ id: 'file-1', fileName: 'fox.png' }));
    typePrompt('a fox like this one');
    fireEvent.click(submitButton());
    expect(onSubmit).toHaveBeenCalledWith({
      count: 1,
      request: {
        model: ImageModels.GPT_IMAGE_1_5,
        mode: 'generate',
        prompt: 'a fox like this one',
        inputs: [{ role: 'reference', fileId: 'file-1' }],
      },
    });
  });

  it('says so when a models refetch drops the picked model', () => {
    const { rerender } = render(
      <TestWrapper>
        <ImageStudioForm models={models} isSubmitting={false} onSubmit={vi.fn()} />
      </TestWrapper>
    );
    pickCard(ImageModels.GEMINI_3_1_FLASH_IMAGE);
    expect(screen.queryByTestId('image-form-changes')).not.toBeInTheDocument();
    rerender(
      <TestWrapper>
        <ImageStudioForm
          models={[{ id: ImageModels.GPT_IMAGE_1_5, name: 'GPT Image 1.5' }]}
          isSubmitting={false}
          onSubmit={vi.fn()}
        />
      </TestWrapper>
    );
    expect(card(ImageModels.GPT_IMAGE_1_5)).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('image-form-changes')).toHaveTextContent('switched to GPT Image 1.5');
  });

  it('says so when no model can generate from a prompt', () => {
    renderForm({ models: [{ id: ImageModels.FLUX_KONTEXT_PRO, name: 'FLUX Kontext Pro' }] });
    expect(screen.getByTestId('image-studio-no-generate-model')).toBeInTheDocument();
    expect(screen.queryByTestId('image-form')).not.toBeInTheDocument();
  });
});

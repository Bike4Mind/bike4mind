import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import ImageStudioForm from './ImageStudioForm';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

type Models = Parameters<typeof ImageStudioForm>[0]['models'];
const models: Models = [
  { id: ImageModels.FLUX_KONTEXT_PRO, name: 'FLUX Kontext Pro' },
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
  fireEvent.change(screen.getByTestId('image-studio-prompt-input'), { target: { value } });

const openSelect = (testId: string) => fireEvent.click(screen.getByTestId(testId));

describe('ImageStudioForm', () => {
  it('opens on the default model and keeps Generate off until there is a prompt', () => {
    renderForm();
    expect(screen.getByTestId('image-studio-model-select')).toHaveTextContent('GPT Image 1.5');
    expect(screen.getByTestId('image-studio-generate-btn')).toBeDisabled();
  });

  it('submits the prompt, the model and "make N"', () => {
    const { onSubmit } = renderForm();
    typePrompt('  a red fox in snow  ');
    fireEvent.click(screen.getByTestId('image-studio-count-3'));
    expect(screen.getByTestId('image-studio-generate-btn')).toHaveTextContent('Generate 3 images');
    fireEvent.click(screen.getByTestId('image-studio-generate-btn'));
    expect(onSubmit).toHaveBeenCalledWith({
      count: 3,
      request: { model: ImageModels.GPT_IMAGE_1_5, mode: 'generate', prompt: 'a red fox in snow' },
    });
  });

  it('shows an edit-only model disabled with its why-not reason', () => {
    renderForm();
    openSelect('image-studio-model-select');
    const kontext = screen.getByTestId(`image-studio-model-option-${ImageModels.FLUX_KONTEXT_PRO}`);
    expect(kontext).toHaveAttribute('aria-disabled', 'true');
    expect(
      within(kontext).getByTestId(`image-studio-model-reason-${ImageModels.FLUX_KONTEXT_PRO}`)
    ).not.toBeEmptyDOMElement();
    expect(screen.getByTestId(`image-studio-model-option-${ImageModels.GPT_IMAGE_1_5}`)).not.toHaveAttribute(
      'aria-disabled',
      'true'
    );
  });

  it('sends a chosen size and disables the models that cannot honour it', () => {
    const { onSubmit } = renderForm();
    openSelect('image-studio-size-select');
    fireEvent.click(screen.getByTestId('image-studio-size-option-1024x1536'));
    openSelect('image-studio-model-select');
    expect(screen.getByTestId(`image-studio-model-option-${ImageModels.GEMINI_3_1_FLASH_IMAGE}`)).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    typePrompt('tall poster');
    fireEvent.click(screen.getByTestId('image-studio-generate-btn'));
    expect(onSubmit).toHaveBeenCalledWith({
      count: 1,
      request: { model: ImageModels.GPT_IMAGE_1_5, mode: 'generate', prompt: 'tall poster', size: '1024x1536' },
    });
  });

  it('hides size and aspect ratio for a model that offers neither', () => {
    renderForm({ models: [{ id: ImageModels.GEMINI_3_1_FLASH_IMAGE, name: 'Nano Banana 2' }] });
    expect(screen.queryByTestId('image-studio-size-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('image-studio-aspect-select')).not.toBeInTheDocument();
  });

  it('offers aspect ratios on a model that takes them', () => {
    const { onSubmit } = renderForm({ models: [{ id: ImageModels.FLUX_PRO_ULTRA, name: 'FLUX Ultra' }] });
    openSelect('image-studio-aspect-select');
    fireEvent.click(screen.getByTestId('image-studio-aspect-option-16:9'));
    typePrompt('wide shot');
    fireEvent.click(screen.getByTestId('image-studio-generate-btn'));
    expect(onSubmit).toHaveBeenCalledWith({
      count: 1,
      request: { model: ImageModels.FLUX_PRO_ULTRA, mode: 'generate', prompt: 'wide shot', aspectRatio: '16:9' },
    });
  });

  it('says so when no model can generate from a prompt', () => {
    renderForm({ models: [{ id: ImageModels.FLUX_KONTEXT_PRO, name: 'FLUX Kontext Pro' }] });
    expect(screen.getByTestId('image-studio-no-generate-model')).toBeInTheDocument();
    expect(screen.queryByTestId('image-studio-form')).not.toBeInTheDocument();
  });
});

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_JOB_PROMPT_MAX_CHARS, ImageModels, SCENE_PRESETS } from '@bike4mind/common';
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

// Cutout state is useReferenceCutouts' (tested on its own); the form only reads it and forwards the toggle.
const cutouts = vi.hoisted(() => ({
  byFileId: {} as Record<string, import('@client/app/components/Studio/capabilityFields').ReferenceCutout>,
  toggleCutout: vi.fn(),
}));
vi.mock('./useReferenceCutouts', () => ({
  useReferenceCutouts: () => ({
    cutoutOf: (fileId: string) => cutouts.byFileId[fileId],
    toggleCutout: cutouts.toggleCutout,
  }),
}));
vi.mock('@client/app/hooks/data/fabFileQueries', () => ({
  useGetFabFile: (fileId: string) => ({ data: { fileUrl: `https://files.test/${fileId}.png` } }),
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
// Opens the model panel on every model (the shortlist hides the rest), then finds one model's option.
const modelOption = (suffix: string) => {
  if (!screen.queryByTestId('image-form-model-panel'))
    fireEvent.click(screen.getByTestId('image-form-model-change-btn'));
  const showAll = screen.queryByTestId('image-form-model-show-all-btn');
  if (showAll?.textContent?.startsWith('Show all')) fireEvent.click(showAll);
  return screen.getByTestId(`image-form-model-option-${suffix}`);
};
const card = (model: ImageModels) => modelOption(model);
const pickCard = (model: ImageModels) => fireEvent.click(modelOption(`${model}-radio`));
const submitButton = () => screen.getByTestId('image-form-submit-btn');

describe('ImageStudioForm', () => {
  beforeEach(() => {
    cutouts.byFileId = {};
    cutouts.toggleCutout.mockClear();
  });

  it('opens on a visible default card and keeps Generate off until there is a prompt', () => {
    renderForm();
    expect(card(ImageModels.GPT_IMAGE_1_5)).toHaveAttribute('data-selected', 'true');
    expect(card(ImageModels.GPT_IMAGE_1_5)).toHaveTextContent('OpenAI');
    expect(modelOption(`${ImageModels.GPT_IMAGE_1_5}-cost`)).toHaveTextContent(/credits per image/);
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
    expect(modelOption(`${ImageModels.FLUX_KONTEXT_PRO}-radio`)).toBeDisabled();
    expect(modelOption(`${ImageModels.FLUX_KONTEXT_PRO}-reason`)).not.toBeEmptyDOMElement();
    expect(modelOption(`${ImageModels.FLUX_PRO_ULTRA}-reason`)).toHaveTextContent('Temporarily unavailable');
  });

  it('sends a chosen quality, and greys the models that cannot honour them', () => {
    const { onSubmit } = renderForm();
    fireEvent.click(screen.getByTestId('image-form-quality-high-btn'));
    expect(modelOption(`${ImageModels.GEMINI_3_1_FLASH_IMAGE}-reason`)).toBeInTheDocument();
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

  describe('Remove background on a reference', () => {
    const addReference = () => act(() => h.applyImage?.({ id: 'file-1', fileName: 'can.jpg' }));

    it('turns the cutout on from the reference chip', () => {
      renderForm();
      addReference();
      fireEvent.click(screen.getByTestId('image-form-references-cutout-file-1-switch'));
      expect(cutouts.toggleCutout).toHaveBeenCalledWith('file-1', true);
    });

    it('holds Generate while the cutout is running', () => {
      cutouts.byFileId = { 'file-1': { status: 'pending' } };
      renderForm();
      addReference();
      typePrompt('the can on a beach');
      expect(screen.getByTestId('image-form-references-cutout-file-1-pending')).toBeInTheDocument();
      expect(screen.getByTestId('image-form-references-invalid')).toHaveTextContent('Removing the background');
      expect(submitButton()).toBeDisabled();
    });

    it('shows the ready cutout on a checkerboard and sends it instead of the original', () => {
      cutouts.byFileId = { 'file-1': { status: 'ready', fileId: 'cutout-1' } };
      const { onSubmit } = renderForm();
      addReference();
      typePrompt('the can on a beach');
      expect(screen.getByTestId('image-form-references-cutout-file-1-preview').querySelector('img')).toHaveAttribute(
        'src',
        'https://files.test/cutout-1.png'
      );
      fireEvent.click(submitButton());
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ inputs: [{ role: 'reference', fileId: 'cutout-1' }] }),
        })
      );
    });

    it('offers the original when the cutout failed', () => {
      cutouts.byFileId = { 'file-1': { status: 'failed', message: 'Remove background works on PNG or JPEG images' } };
      renderForm();
      addReference();
      typePrompt('the can on a beach');
      expect(screen.getByTestId('image-form-references-invalid')).toHaveTextContent('PNG or JPEG');
      expect(submitButton()).toBeDisabled();
      fireEvent.click(screen.getByTestId('image-form-references-fix-btn'));
      expect(cutouts.toggleCutout).toHaveBeenCalledWith('file-1', false);
    });

    it('forgets the cutout when the reference is removed', () => {
      renderForm();
      addReference();
      fireEvent.click(screen.getByTestId('image-form-references-remove-file-1-btn'));
      expect(cutouts.toggleCutout).toHaveBeenCalledWith('file-1', false);
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
  describe('Look chips', () => {
    const [slate, kitchen] = SCENE_PRESETS;
    const chip = (id: string) => screen.getByTestId(`image-form-look-${id}-chip`);
    const promptInput = () => screen.getByTestId('image-form-prompt-input');

    it('shows a chip per scene preset, none selected', () => {
      renderForm();
      for (const preset of SCENE_PRESETS) {
        expect(chip(preset.id)).toHaveAccessibleName(preset.name);
        expect(chip(preset.id)).toHaveAttribute('aria-pressed', 'false');
      }
    });

    it('fills an empty prompt and enables Generate', () => {
      renderForm();
      fireEvent.click(chip(slate.id));
      expect(promptInput()).toHaveValue(slate.promptFragment);
      expect(chip(slate.id)).toHaveAttribute('aria-pressed', 'true');
      expect(submitButton()).toBeEnabled();
    });

    it("adds to the user's prompt, swaps scenes and clears on a second click", () => {
      renderForm();
      typePrompt('A lemon tart');
      fireEvent.click(chip(slate.id));
      expect(promptInput()).toHaveValue(`A lemon tart, ${slate.promptFragment}`);

      fireEvent.click(chip(kitchen.id));
      expect(promptInput()).toHaveValue(`A lemon tart, ${kitchen.promptFragment}`);
      expect(chip(slate.id)).toHaveAttribute('aria-pressed', 'false');
      expect(chip(kitchen.id)).toHaveAttribute('aria-pressed', 'true');

      fireEvent.click(chip(kitchen.id));
      expect(promptInput()).toHaveValue('A lemon tart');
      expect(chip(kitchen.id)).toHaveAttribute('aria-pressed', 'false');
    });

    it('deselects when the user edits the scene words away', () => {
      renderForm();
      fireEvent.click(chip(slate.id));
      typePrompt('A tart on dark stone');
      expect(chip(slate.id)).toHaveAttribute('aria-pressed', 'false');
    });

    it('disables a chip whose words would not fit in the prompt', () => {
      renderForm();
      const nearlyFull = 'x'.repeat(IMAGE_JOB_PROMPT_MAX_CHARS - 10);
      typePrompt(nearlyFull);
      expect(chip(slate.id)).toBeDisabled();
      fireEvent.click(chip(slate.id));
      expect(promptInput()).toHaveValue(nearlyFull);
    });

    it('submits the prompt with the scene in it', () => {
      const { onSubmit } = renderForm();
      typePrompt('A lemon tart');
      fireEvent.click(chip(slate.id));
      fireEvent.click(submitButton());
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ prompt: `A lemon tart, ${slate.promptFragment}` }),
        })
      );
    });
  });
});

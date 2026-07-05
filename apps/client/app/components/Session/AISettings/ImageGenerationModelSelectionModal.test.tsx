import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { BFL_SAFETY_TOLERANCE, IMAGE_SIZE_CONSTRAINTS, ImageModels, ModelName } from '@bike4mind/common';
import { getThemeConfig } from '../../../utils/themes';

// Use the real app theme so MUI Joy sx callbacks that access custom palette tokens
// (e.g. theme.palette.aiSettings.modal.borderColor) resolve without throwing.
// Spreading getThemeConfig() avoids TypeScript's excess-property check on the extendTheme input.
const appTheme = extendTheme({ ...getThemeConfig() });

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// ---- Mock useLLM ----
const mockSetLLM = vi.fn();
let mockSize: string = '1024x1024';

vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: () => ({
    model: 'gpt-4o',
    imageModel: ImageModels.FLUX_PRO_1_1,
    imageEditModel: ImageModels.GPT_IMAGE_1_5,
    setLLM: mockSetLLM,
    size: mockSize,
    quality: 'standard',
    style: 'vivid',
    seed: null,
    output_format: 'png',
    width: undefined,
    height: undefined,
    aspect_ratio: undefined,
    safety_tolerance: 2,
    prompt_upsampling: false,
    temperature: 0.9,
  }),
}));

// ---- Mock data hooks ----
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [] }),
}));

vi.mock('@client/app/hooks/data/useModelStats', () => ({
  useModelStats: () => ({ data: undefined }),
}));

// ---- Capture setModel prop from ModelSelection ----
let capturedSetModel: ((model: ModelName) => void) | null = null;

vi.mock('@client/app/components/Session/ModelSelection', () => ({
  default: vi.fn(({ setModel }: { setModel: (m: ModelName) => void }) => {
    capturedSetModel = setModel;
    return <div data-testid="model-selection" />;
  }),
}));

// ---- Lightweight mocks for visual-only components ----
vi.mock('@client/app/components/help', () => ({
  ContextHelpButton: () => null,
}));

vi.mock('@client/app/utils/aiSettingsUtils', () => ({
  getModelPriceTier: () => ({ tier: 'Low', variant: 'green' }),
  isNewModel: () => false,
  getModelSpeedFromStats: () => 'fast',
  getModelSpeedVariant: () => 'success',
  getModelSpeedTooltip: () => 'Fast',
}));

vi.mock('./MetaDataChips', () => ({
  default: () => null,
}));

import ImageGenerationModelSelectionModal from './ImageGenerationModelSelectionModal';

describe('ImageGenerationModelSelectionModal — handleModelChange size reset', () => {
  beforeEach(() => {
    mockSetLLM.mockClear();
    capturedSetModel = null;
  });

  it('resets size to GPT default when switching to a GPT model with a BFL-only size', async () => {
    mockSize = '1440x810'; // BFL-specific size that caused the production bug

    render(
      <TestWrapper>
        <ImageGenerationModelSelectionModal open={true} onClose={vi.fn()} />
      </TestWrapper>
    );

    expect(capturedSetModel).not.toBeNull();

    await act(async () => {
      capturedSetModel!(ImageModels.GPT_IMAGE_1_5 as ModelName);
    });

    expect(mockSetLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        imageModel: ImageModels.GPT_IMAGE_1_5,
        size: IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.defaultSize,
      })
    );
  });

  it('does not override size when switching to a GPT model with a valid GPT size', async () => {
    mockSize = '1024x1024'; // valid GPT size

    render(
      <TestWrapper>
        <ImageGenerationModelSelectionModal open={true} onClose={vi.fn()} />
      </TestWrapper>
    );

    expect(capturedSetModel).not.toBeNull();

    await act(async () => {
      capturedSetModel!(ImageModels.GPT_IMAGE_1_5 as ModelName);
    });

    const lastCall = mockSetLLM.mock.calls[mockSetLLM.mock.calls.length - 1][0];
    expect(lastCall).not.toHaveProperty('size');
  });

  it('does not reset size when switching to a BFL model with a BFL size', async () => {
    mockSize = '1440x810'; // BFL size is valid for BFL models

    render(
      <TestWrapper>
        <ImageGenerationModelSelectionModal open={true} onClose={vi.fn()} />
      </TestWrapper>
    );

    expect(capturedSetModel).not.toBeNull();

    await act(async () => {
      capturedSetModel!(ImageModels.FLUX_PRO_1_1 as ModelName);
    });

    const lastCall = mockSetLLM.mock.calls[mockSetLLM.mock.calls.length - 1][0];
    expect(lastCall).not.toHaveProperty('size');
  });

  it('resets size for any BFL-specific size when switching to GPT model', async () => {
    mockSize = '1280x720'; // another BFL-only size

    render(
      <TestWrapper>
        <ImageGenerationModelSelectionModal open={true} onClose={vi.fn()} />
      </TestWrapper>
    );

    await act(async () => {
      capturedSetModel!(ImageModels.GPT_IMAGE_1 as ModelName);
    });

    expect(mockSetLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        size: IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.defaultSize,
      })
    );
  });
});

describe('ImageGenerationModelSelectionModal — safety_tolerance hard cap', () => {
  it('does not offer safety_tolerance values above the hard cap', () => {
    const { getByTestId, queryByText } = render(
      <TestWrapper>
        <ImageGenerationModelSelectionModal open={true} onClose={vi.fn()} />
      </TestWrapper>
    );

    const sliderInput = getByTestId('safety-tolerance-slider').querySelector('input') as HTMLInputElement;
    expect(sliderInput.max).toBe(String(BFL_SAFETY_TOLERANCE.MAX));
    expect(BFL_SAFETY_TOLERANCE.MAX).toBe(2);
    // The pre-cap top-of-scale mark must be gone from the UI copy
    expect(queryByText('🌶️ Spicy')).toBeNull();
  });
});

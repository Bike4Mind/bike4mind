import React from 'react';
import { CssVarsProvider } from '@mui/joy/styles';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, ModelName } from '@bike4mind/common';
import ModelSelection from './ModelSelection';

const { setLLM } = vi.hoisted(() => ({ setLLM: vi.fn() }));

const textModel = {
  id: 'gpt-text-model',
  name: 'GPT Text Model',
  description: 'Text model',
  type: 'text',
  contextWindow: 128000,
  max_tokens: 4096,
} as ModelInfo;

const imageModel = {
  id: 'gpt-image-model',
  name: 'GPT Image Model',
  description: 'Image model',
  type: 'image',
  contextWindow: 128000,
  max_tokens: 4096,
} as ModelInfo;

vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ isLoading: false, error: null }),
}));

vi.mock('@client/app/hooks/useAccessibleModels', () => ({
  useAccessibleModels: () => ({
    accessibleModels: [textModel, imageModel],
    accessibleTextModels: [textModel],
    accessibleImageModels: [imageModel],
    accessibleVideoModels: [],
    isLoading: false,
  }),
}));

vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (state: { setLLM: typeof setLLM }) => unknown) => selector({ setLLM }),
}));

vi.mock('@client/app/hooks/data/useModelStats', () => ({
  useModelStats: () => ({ data: { popularity: {}, avgResponseTime: {} }, isLoading: false }),
}));

vi.mock('@client/app/hooks/useFavoriteModels', () => ({
  useFavoriteModels: () => ({ isFavorite: () => false, toggleFavorite: vi.fn() }),
}));

vi.mock('@client/app/utils/modelRanking', () => ({
  sortModelsByCapability: (models: ModelInfo[]) => models,
}));

vi.mock('@client/app/utils/commands', () => ({
  isImageModel: (model: string) => model.includes('image'),
}));

vi.mock('@client/app/utils/aiSettingsUtils', () => ({
  getModelPriceTier: () => ({ tier: 'Low', variant: 'green' }),
  isOpenAIModel: (name: string) => name.toLowerCase().includes('gpt'),
  getModelSpeedVariant: () => 'green',
  getModelSpeedTooltip: () => '',
  getTopUsedModelsFromStats: () => [],
  getModelSpeedFromStats: () => null,
  getPriceTierTooltip: () => '',
  isNewModel: () => false,
}));

vi.mock('./AISettings/MetaDataChips', () => ({
  default: ({ label }: { label: string }) => <span>{label}</span>,
}));

const renderSelection = (props: {
  setModel?: (model: ModelName) => void;
  onSelectionComplete?: () => void;
  onSettingsClick?: (model: ModelInfo) => void;
}) =>
  render(
    <CssVarsProvider>
      <ModelSelection
        model={textModel.id}
        setModel={props.setModel ?? vi.fn()}
        onSelectionComplete={props.onSelectionComplete}
        imageModel={false}
        showAllModels
        modelFilter="all"
        onSettingsClick={props.onSettingsClick}
      />
    </CssVarsProvider>
  );

describe('ModelSelection apply behavior', () => {
  beforeEach(() => {
    setLLM.mockClear();
  });

  it.each([
    ['text', textModel, 'lastUsedTextModel'],
    ['image', imageModel, 'lastUsedImageModel'],
  ] as const)('applies a %s model and completes the selection when its card is clicked', (_, model, memoryKey) => {
    const setModel = vi.fn();
    const onSelectionComplete = vi.fn();
    renderSelection({ setModel, onSelectionComplete });

    fireEvent.click(screen.getByTestId(`model-card-${model.id}`));

    expect(setModel).toHaveBeenCalledWith(model.id);
    expect(setLLM).toHaveBeenCalledWith({ [memoryKey]: model.id });
    expect(onSelectionComplete).toHaveBeenCalledOnce();
  });

  it('opens View more without completing the selection', () => {
    const setModel = vi.fn();
    const onSelectionComplete = vi.fn();
    const onSettingsClick = vi.fn();
    renderSelection({ setModel, onSelectionComplete, onSettingsClick });

    fireEvent.click(screen.getByTestId(`model-view-more-${imageModel.id}`));

    expect(setModel).toHaveBeenCalledWith(imageModel.id);
    expect(onSettingsClick).toHaveBeenCalledWith(imageModel);
    expect(onSelectionComplete).not.toHaveBeenCalled();
  });
});

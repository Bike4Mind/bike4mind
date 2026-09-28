import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { ImageModels } from '@bike4mind/common';
import { getThemeConfig } from '../../../utils/themes';

// A state check alone passes while the Select renders blank, which is exactly how the blank
// Image Size row survived the fix to the sibling modal. These assert what is on screen.

const appTheme = extendTheme({ ...getThemeConfig() });

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

let llmState: Record<string, unknown> = {};

vi.mock('@client/app/contexts/LLMContext', () => {
  // useLLM is called both as a selector hook and as a store handle (`useLLM.setState`).
  const useLLM = Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => (selector ? selector(llmState) : llmState),
    { setState: vi.fn() }
  );
  return { useLLM };
});

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: 'session-1' }),
}));

vi.mock('@client/app/hooks/data/useModelStats', () => ({
  useModelStats: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: {} }),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {},
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false }),
}));

vi.mock('@client/app/utils/sessionsAPICalls', () => ({
  updateSessionToServer: vi.fn().mockResolvedValue(undefined),
}));

// Heavy children whose own context chains are irrelevant to the size row.
vi.mock('./ToolsSection', () => ({ default: () => <div data-testid="tools-section" /> }));
vi.mock('./ResearchConfigPanel', () => ({ ResearchConfigPanel: () => <div data-testid="research-config" /> }));
vi.mock('./AudioGenerationSettings', () => ({ AudioGenerationSettings: () => <div data-testid="audio-settings" /> }));
vi.mock('../ImageTemplates/ImageTemplatePanel', () => ({
  ImageTemplatePanel: () => <div data-testid="image-templates" />,
}));
vi.mock('../ModelSelection', () => ({
  default: () => <div data-testid="model-selection" />,
  getModelBackend: () => 'OpenAI',
}));
vi.mock('@client/app/components/help', () => ({
  ContextHelpButton: () => null,
  FieldTooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  FIELD_TOOLTIPS: new Proxy({}, { get: () => 'tooltip' }),
}));

const modelInfoRows = [
  { id: ImageModels.GPT_IMAGE_2, name: 'GPT Image 2', contextWindow: 0, max_tokens: 0 },
  { id: ImageModels.FLUX_PRO_1_1, name: 'Flux Pro 1.1', contextWindow: 0, max_tokens: 0 },
];

vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: modelInfoRows }),
}));

import { AdvancedAIModal } from './AdvancedAIModal';
import { useAdvancedAISettings } from './useAdvancedAISettingsStore';

const renderDetailsDialog = () => {
  useAdvancedAISettings.setState({ modelDetailsOpen: true });
  // The details dialog is a sibling of the settings modal, so it renders with `open={false}`
  // and the rest of the settings screen stays out of the tree.
  return render(
    <TestWrapper>
      <AdvancedAIModal
        open={false}
        onClose={vi.fn()}
        spokenWords={0}
        setSpokenWords={vi.fn()}
        stream={true}
        setStream={vi.fn()}
        voiceOver={false}
        onRollDice={vi.fn()}
      />
    </TestWrapper>
  );
};

describe('AdvancedAIModal - Image Size row in the model details dialog', () => {
  beforeEach(() => {
    llmState = {
      model: ImageModels.GPT_IMAGE_2,
      temperature: 0.9,
      max_tokens: 4096,
      size: '1024x1024',
      quality: 'low',
      style: 'vivid',
      tools: [],
      researchMode: undefined,
      addResearchConfiguration: vi.fn(),
      removeResearchConfiguration: vi.fn(),
      updateResearchConfiguration: vi.fn(),
    };
  });

  it('shows a custom size gpt-image-2 supports but does not list as a preset', () => {
    // 1280x960 is the BFL default and survives a switch to gpt-image-2, which accepts any
    // resolution meeting its constraints. Before the shared helper this row rendered blank.
    llmState.size = '1280x960';

    const { getByTestId } = renderDetailsDialog();

    expect(getByTestId('model-details-size-select')).toHaveTextContent('1280x960');
  });

  it('shows a preset size', () => {
    llmState.size = '2048x2048';

    const { getByTestId } = renderDetailsDialog();

    expect(getByTestId('model-details-size-select')).toHaveTextContent('2048x2048');
  });

  it('shows the size for a BFL model', () => {
    llmState.model = ImageModels.FLUX_PRO_1_1;
    llmState.size = '1440x810';

    const { getByTestId } = renderDetailsDialog();

    expect(getByTestId('model-details-size-select')).toHaveTextContent('1440x810');
  });
});

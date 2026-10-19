import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ModelInfo } from '@bike4mind/common';
import { getThemeConfig } from '../../../utils/themes';

const appTheme = extendTheme({ ...getThemeConfig() });

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

let llmState: Record<string, unknown> = {};
const setLLM = vi.hoisted(() => vi.fn());

vi.mock('@client/app/contexts/LLMContext', () => {
  // useLLM is called both as a selector hook and as a store handle (`useLLM.setState`).
  const useLLM = Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => (selector ? selector(llmState) : llmState),
    { setState: setLLM }
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
// Opens the details screen on the active model, which is where the editable slider lives.
vi.mock('../ModelSelection', () => ({
  default: ({ onSettingsClick }: { onSettingsClick: (model: ModelInfo) => void }) => (
    <button
      data-testid="open-details-active"
      onClick={() => onSettingsClick(modelInfoRows[0] as unknown as ModelInfo)}
    />
  ),
  getModelBackend: () => 'Anthropic',
}));
vi.mock('@client/app/components/help', () => ({
  ContextHelpButton: () => null,
  FieldTooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  FIELD_TOOLTIPS: new Proxy({}, { get: () => 'tooltip' }),
}));

// Mutated per test; read through the hoisted reference by the useModelInfo mock.
const modelInfoRows = vi.hoisted(() => [
  {
    id: 'claude-adaptive',
    name: 'Claude Adaptive',
    type: 'text',
    contextWindow: 1_000_000,
    max_tokens: 128_000,
    thinkingStyle: 'adaptive' as string | undefined,
  },
]);

vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: modelInfoRows }),
}));

import { AdvancedAIModal } from './AdvancedAIModal';

const renderDetails = (maxTokens: number) => {
  llmState = {
    model: 'claude-adaptive',
    temperature: 0.9,
    max_tokens: maxTokens,
    tools: [],
    researchMode: undefined,
    addResearchConfiguration: vi.fn(),
    removeResearchConfiguration: vi.fn(),
    updateResearchConfiguration: vi.fn(),
  };
  render(
    <TestWrapper>
      <AdvancedAIModal
        open
        onClose={vi.fn()}
        spokenWords={0}
        setSpokenWords={vi.fn()}
        stream
        setStream={vi.fn()}
        voiceOver={false}
        onRollDice={vi.fn()}
      />
    </TestWrapper>
  );
  fireEvent.click(screen.getByTestId('open-details-active'));
};

describe('AdvancedAIModal - Max output tokens below the reasoning floor', () => {
  beforeEach(() => {
    modelInfoRows[0].thinkingStyle = 'adaptive';
  });

  // The server lifts this value to the floor, so the slider must not imply 8K is what applies.
  it('warns when an adaptive model is set below the floor', () => {
    renderDetails(8192);

    expect(screen.getByTestId('token-allocation-reasoning-floor-warning')).toHaveTextContent(
      'values below 64 000 are raised to 64 000 when sent'
    );
  });

  it('does not warn at or above the floor', () => {
    renderDetails(64_000);

    expect(screen.queryByTestId('token-allocation-reasoning-floor-warning')).toBeNull();
  });

  // A non-adaptive model's budget is honored as set, so a low value there is a real cap.
  it('does not warn on a model that does not reason inside its budget', () => {
    modelInfoRows[0].thinkingStyle = undefined;
    renderDetails(8192);

    expect(screen.queryByTestId('token-allocation-reasoning-floor-warning')).toBeNull();
  });
});

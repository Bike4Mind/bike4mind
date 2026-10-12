import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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
// Stands in for a card's settings gear: opens the details screen on a chosen model.
vi.mock('../ModelSelection', () => ({
  default: ({ onSettingsClick }: { onSettingsClick: (model: ModelInfo) => void }) => (
    <>
      <button data-testid="open-details" onClick={() => onSettingsClick(modelInfoRows[1] as unknown as ModelInfo)} />
      <button
        data-testid="open-details-active"
        onClick={() => onSettingsClick(modelInfoRows[0] as unknown as ModelInfo)}
      />
      <button
        data-testid="open-details-unlisted"
        onClick={() =>
          onSettingsClick({
            id: 'ghost',
            name: 'Ghost',
            type: 'text',
            contextWindow: 1000,
            max_tokens: 100,
          } as unknown as ModelInfo)
        }
      />
    </>
  ),
  getModelBackend: () => 'OpenAI',
}));
vi.mock('@client/app/components/help', () => ({
  ContextHelpButton: () => null,
  FieldTooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  FIELD_TOOLTIPS: new Proxy({}, { get: () => 'tooltip' }),
}));

const modelInfoRows = vi.hoisted(() => [
  { id: 'gpt-active', name: 'GPT Active', type: 'text', contextWindow: 1000, max_tokens: 100 },
  { id: 'claude-other', name: 'Claude Other', type: 'text', contextWindow: 1000, max_tokens: 100 },
]);

vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: modelInfoRows }),
}));

import { AdvancedAIModal } from './AdvancedAIModal';

const renderModal = () => {
  llmState = {
    model: 'gpt-active',
    temperature: 0.9,
    max_tokens: 100,
    tools: [],
    researchMode: undefined,
    addResearchConfiguration: vi.fn(),
    removeResearchConfiguration: vi.fn(),
    updateResearchConfiguration: vi.fn(),
  };
  setLLM.mockClear();
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
};

describe('AdvancedAIModal - Use this model', () => {
  it('applies the previewed model, announces it and keeps focus inside the dialog', () => {
    renderModal();

    fireEvent.click(screen.getByTestId('open-details'));
    expect(screen.getByTestId('model-selection-status')).toHaveTextContent('');

    fireEvent.click(screen.getByTestId('model-use-btn'));

    expect(setLLM).toHaveBeenCalled();
    expect(screen.getByTestId('model-selection-status')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('model-selection-status')).toHaveTextContent('Now using Claude Other');
    expect(screen.getByTestId('model-details-back-btn')).toHaveFocus();
  });

  it('does not announce when the shown model is already active', () => {
    renderModal();

    fireEvent.click(screen.getByTestId('open-details-active'));
    const useButton = screen.queryByTestId('model-use-btn');
    if (useButton) fireEvent.click(useButton);

    expect(setLLM).not.toHaveBeenCalled();
    expect(screen.getByTestId('model-selection-status')).toBeEmptyDOMElement();
  });

  it('does not announce when the shown model is missing from the model list', () => {
    renderModal();

    fireEvent.click(screen.getByTestId('open-details-unlisted'));
    fireEvent.click(screen.getByTestId('model-use-btn'));

    expect(setLLM).not.toHaveBeenCalled();
    expect(screen.getByTestId('model-selection-status')).toBeEmptyDOMElement();
  });

  it('clears the previous announcement when details of another model are viewed', () => {
    renderModal();

    fireEvent.click(screen.getByTestId('open-details'));
    fireEvent.click(screen.getByTestId('model-use-btn'));
    expect(screen.getByTestId('model-selection-status')).toHaveTextContent('Now using Claude Other');

    fireEvent.click(screen.getByTestId('open-details-unlisted'));
    expect(screen.getByTestId('model-selection-status')).toBeEmptyDOMElement();
  });
});

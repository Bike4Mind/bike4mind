import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { ChatModels, type ModelInfo } from '@bike4mind/common';
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

const user = vi.hoisted(() => ({ current: { id: 'user-1', preferredReasoningEffort: 'auto' as string | null } }));
const setCurrentUser = vi.hoisted(() => vi.fn());
const apiPut = vi.hoisted(() => vi.fn());

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ user: user.current, currentUser: user.current, setCurrentUser }),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { put: apiPut },
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
    id: 'claude-opus-5-5' as string,
    name: 'Claude Opus 5.5',
    type: 'text',
    contextWindow: 1_000_000,
    max_tokens: 128_000,
    pricing: {},
    backend: 'anthropic',
    can_think: true as boolean | undefined,
    thinkingStyle: 'adaptive' as string | undefined,
  },
]);

vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: modelInfoRows }),
}));

import { AdvancedAIModal } from './AdvancedAIModal';

// `activeModel` differing from the row the details screen opens on makes it a read-only preview.
const renderDetails = (model: string, activeModel = model) => {
  llmState = {
    model: activeModel,
    temperature: 0.9,
    max_tokens: 64_000,
    tools: [],
    researchMode: undefined,
    addResearchConfiguration: vi.fn(),
    removeResearchConfiguration: vi.fn(),
    updateResearchConfiguration: vi.fn(),
  };
  const modal = () => (
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
  const rendered = render(modal());
  fireEvent.click(screen.getByTestId('open-details-active'));
  return () => rendered.rerender(modal());
};

const useModel = (id: string, extra: { backend?: string; can_think?: boolean; thinkingStyle?: string }) =>
  Object.assign(modelInfoRows[0], { id, backend: 'anthropic', can_think: true, thinkingStyle: undefined }, extra);

const offeredLevels = () => {
  const select = screen.getByTestId('reasoning-effort-select');
  fireEvent.click(within(select).getByRole('combobox'));
  return screen.getAllByRole('option').map(option => option.textContent);
};

const resetTooltip = async () => {
  fireEvent.mouseOver(screen.getByTestId('advanced-settings-reset-btn'));
  return (await screen.findByRole('tooltip')).textContent;
};

describe('AdvancedAIModal - Reasoning Effort selector', () => {
  beforeEach(() => {
    user.current = { id: 'user-1', preferredReasoningEffort: 'auto' };
    apiPut.mockReset().mockResolvedValue({ data: { id: 'user-1', preferredReasoningEffort: 'auto' } });
    setCurrentUser.mockReset();
    setLLM.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is shown on an adaptive Claude model with the levels it takes', async () => {
    useModel(ChatModels.CLAUDE_5_5_OPUS, { thinkingStyle: 'adaptive' });
    renderDetails(ChatModels.CLAUDE_5_5_OPUS);

    expect(offeredLevels()).toEqual(['Auto', 'Low (Fast)', 'Medium', 'High', 'Extra High (Best)']);
  });

  it('explains effort precedence over the separate Thinking control', () => {
    useModel(ChatModels.CLAUDE_5_5_HAIKU, { thinkingStyle: 'adaptive' });
    renderDetails(ChatModels.CLAUDE_5_5_HAIKU);
    expect(screen.getByTestId('reasoning-effort-thinking-precedence')).toHaveTextContent(
      'Explicit effort overrides Thinking. Auto follows Thinking and model defaults. None turns reasoning off.'
    );
  });

  it('offers None on an adaptive Claude model that can turn thinking off', () => {
    useModel(ChatModels.CLAUDE_5_5_HAIKU, { thinkingStyle: 'adaptive' });
    renderDetails(ChatModels.CLAUDE_5_5_HAIKU);

    expect(offeredLevels()).toContain('None');
  });

  it('is hidden on a legacy Claude model, and the reset tooltip does not mention reasoning effort', async () => {
    useModel(ChatModels.CLAUDE_4_5_HAIKU, {});
    renderDetails(ChatModels.CLAUDE_4_5_HAIKU);

    expect(screen.queryByTestId('reasoning-effort-select')).toBeNull();
    expect(await resetTooltip()).toContain('Tools are not affected.');
  });

  it('keeps the OpenAI list on a GPT reasoning model', () => {
    useModel(ChatModels.GPT5, { backend: 'openai' });
    renderDetails(ChatModels.GPT5);

    expect(offeredLevels()).toEqual(['Auto', 'Low (Fast)', 'Medium', 'High (Best)']);
  });

  it('says the reset leaves reasoning effort alone where the selector is shown', async () => {
    useModel(ChatModels.CLAUDE_5_5_OPUS, { thinkingStyle: 'adaptive' });
    renderDetails(ChatModels.CLAUDE_5_5_OPUS);

    expect(await resetTooltip()).toContain('Tools and reasoning effort are not affected.');
  });

  it('keeps a stored Extra High on a Claude model that takes it', () => {
    user.current = { id: 'user-1', preferredReasoningEffort: 'xhigh' };
    useModel(ChatModels.CLAUDE_5_5_OPUS, { thinkingStyle: 'adaptive' });
    renderDetails(ChatModels.CLAUDE_5_5_OPUS);

    expect(apiPut).not.toHaveBeenCalled();
  });

  it('resets a stored Extra High to Auto on a model that does not offer it', async () => {
    user.current = { id: 'user-1', preferredReasoningEffort: 'xhigh' };
    useModel(ChatModels.GPT5, { backend: 'openai' });
    renderDetails(ChatModels.GPT5);

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/users/user-1/update', { preferredReasoningEffort: 'auto' })
    );
  });

  it('resets a stored None, which only some Claude models offer, to Auto on an OpenAI model', async () => {
    user.current = { id: 'user-1', preferredReasoningEffort: 'none' };
    useModel(ChatModels.GPT5, { backend: 'openai' });
    renderDetails(ChatModels.GPT5);

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/users/user-1/update', { preferredReasoningEffort: 'auto' })
    );
  });

  it('reads an unset preference as Auto and leaves it alone', () => {
    user.current = { id: 'user-1', preferredReasoningEffort: null };
    useModel(ChatModels.CLAUDE_5_5_OPUS, { thinkingStyle: 'adaptive' });
    renderDetails(ChatModels.CLAUDE_5_5_OPUS);

    expect(within(screen.getByTestId('reasoning-effort-select')).getByRole('combobox').textContent).toBe('Auto');
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('logs a failed reset and keeps the stored preference', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiPut.mockReset().mockRejectedValue(new Error('offline'));
    user.current = { id: 'user-1', preferredReasoningEffort: 'none' };
    useModel(ChatModels.GPT5, { backend: 'openai' });
    renderDetails(ChatModels.GPT5);

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith('Failed to reset reasoning effort:', expect.any(Error))
    );
    expect(setCurrentUser).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('leaves the stored preference alone while previewing a model that does not offer it', () => {
    user.current = { id: 'user-1', preferredReasoningEffort: 'xhigh' };
    useModel(ChatModels.GPT5, { backend: 'openai' });
    renderDetails(ChatModels.GPT5, ChatModels.CLAUDE_5_5_OPUS);

    expect(screen.getByTestId('reasoning-effort-select')).toBeTruthy();
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('resets an unsupported preference when the previewed model becomes active', async () => {
    user.current = { id: 'user-1', preferredReasoningEffort: 'xhigh' };
    useModel(ChatModels.GPT5, { backend: 'openai' });
    const refresh = renderDetails(ChatModels.GPT5, ChatModels.CLAUDE_5_5_OPUS);
    expect(apiPut).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('model-use-btn'));
    expect(setLLM).toHaveBeenCalledWith(expect.objectContaining({ model: ChatModels.GPT5 }));
    llmState = { ...llmState, model: ChatModels.GPT5 };
    refresh();

    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/users/user-1/update', { preferredReasoningEffort: 'auto' })
    );
  });
});

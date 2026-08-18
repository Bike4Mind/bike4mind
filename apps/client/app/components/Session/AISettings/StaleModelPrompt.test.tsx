import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * Reopening an old notebook must not silently resume on its stale pin (#951):
 * the prompt appears, upgrades in one click, and stays gone once declined.
 */

const supersededModels = [{ id: 'grok-3', name: 'Grok 3', replacementId: 'grok-4.5', replacementName: 'Grok 4.5' }];
const models = [
  { id: 'grok-4.5', name: 'Grok 4.5', type: 'text', contextWindow: 500_000, max_tokens: 64_000 },
  { id: 'grok-3', name: 'Grok 3', type: 'text', contextWindow: 131_072, max_tokens: 8_192 },
];

const setLLMState = vi.fn();
const updateSessionToServer = vi.fn().mockResolvedValue(undefined);

vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: models }),
  useSupersededModels: () => ({ data: supersededModels }),
}));
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: Object.assign(() => undefined, { setState: (...args: unknown[]) => setLLMState(...args) }),
}));
vi.mock('@client/app/utils/sessionsAPICalls', () => ({
  updateSessionToServer: (...args: unknown[]) => updateSessionToServer(...args),
}));

import StaleModelPrompt from './StaleModelPrompt';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderPrompt = (pinnedModel: string | null, sessionId: string | null = 'session-1') =>
  render(<StaleModelPrompt sessionId={sessionId} pinnedModel={pinnedModel} />, { wrapper: Wrapper });

describe('StaleModelPrompt', () => {
  beforeEach(() => {
    localStorage.clear();
    setLLMState.mockClear();
    updateSessionToServer.mockClear();
  });

  it('prompts with both model names when the session is pinned to a superseded model', () => {
    const { getByTestId } = renderPrompt('grok-3');
    expect(getByTestId('stale-model-prompt').textContent).toContain('Grok 3');
    expect(getByTestId('stale-model-prompt').textContent).toContain('Grok 4.5');
  });

  it('stays silent for a current model', () => {
    expect(renderPrompt('grok-4.5').queryByTestId('stale-model-prompt')).toBeNull();
  });

  it('stays silent when the session has no pin', () => {
    expect(renderPrompt(null).queryByTestId('stale-model-prompt')).toBeNull();
  });

  it('stays silent outside a session, where there is no pin to persist to', () => {
    expect(renderPrompt('grok-3', null).queryByTestId('stale-model-prompt')).toBeNull();
  });

  it('switches the live model and repins the session on one click', () => {
    const { getByTestId, queryByTestId } = renderPrompt('grok-3');
    fireEvent.click(getByTestId('stale-model-switch-btn'));

    expect(setLLMState).toHaveBeenCalledWith(expect.objectContaining({ model: 'grok-4.5' }));
    expect(updateSessionToServer).toHaveBeenCalledWith({ id: 'session-1', lastUsedModel: 'grok-4.5' });
    expect(queryByTestId('stale-model-prompt')).toBeNull();
  });

  it('does not rewrite the pin when declined, and does not ask that session again', () => {
    const first = renderPrompt('grok-3');
    fireEvent.click(first.getByTestId('stale-model-dismiss-btn'));
    expect(setLLMState).not.toHaveBeenCalled();
    expect(updateSessionToServer).not.toHaveBeenCalled();
    expect(first.queryByTestId('stale-model-prompt')).toBeNull();

    first.unmount();
    expect(renderPrompt('grok-3').queryByTestId('stale-model-prompt')).toBeNull();
  });

  it('still asks in a different notebook after a decline', () => {
    const first = renderPrompt('grok-3', 'session-1');
    fireEvent.click(first.getByTestId('stale-model-dismiss-btn'));
    first.unmount();

    expect(renderPrompt('grok-3', 'session-2').queryByTestId('stale-model-prompt')).toBeTruthy();
  });
});

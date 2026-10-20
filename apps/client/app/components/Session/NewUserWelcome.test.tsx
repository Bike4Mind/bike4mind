import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ModelAnswerCost } from '@client/app/utils/creditEstimate';

const { state, sendPrompt, setChatInputValue } = vi.hoisted(() => ({
  state: {
    sessions: [] as unknown[],
    isSuccess: true,
    isFetching: false,
    balance: 9982,
    enforceCredits: true,
    hasComposer: true,
    answerCost: { modelName: 'Claude Sonnet 5.5', creditsPerAnswer: 54 } as ModelAnswerCost | null,
  },
  sendPrompt: vi.fn(() => Promise.resolve(true)),
  setChatInputValue: vi.fn(),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'user-1', emailVerified: true, tags: [] } }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useGetOwnSessions: () => ({
    data: { pages: [{ data: state.sessions }] },
    isSuccess: state.isSuccess,
    isFetching: state.isFetching,
  }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'enforceCredits' ? state.enforceCredits : undefined),
}));
vi.mock('@client/app/hooks/useEffectiveCredits', () => ({ useEffectiveCredits: () => state.balance }));
vi.mock('@client/app/hooks/useSelectedModelAnswerCost', () => ({
  useSelectedModelAnswerCost: () => state.answerCost,
}));
vi.mock('@client/app/hooks/useChatActions', () => ({
  default: (selector: (s: { sendPrompt: unknown }) => unknown) =>
    selector({ sendPrompt: state.hasComposer ? sendPrompt : null }),
}));
vi.mock('@client/app/hooks/useChatInput', () => ({
  useChatInput: (selector: (s: { setChatInputValue: unknown; requestFocus: unknown }) => unknown) =>
    selector({ setChatInputValue, requestFocus: vi.fn() }),
}));

import NewUserWelcome from './NewUserWelcome';
import { STARTER_PROMPTS } from './newUserWelcomeModel';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderWelcome = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <NewUserWelcome />
    </CssVarsProvider>
  );

describe('NewUserWelcome', () => {
  beforeEach(() => {
    state.sessions = [];
    state.isSuccess = true;
    state.isFetching = false;
    state.balance = 9982;
    state.enforceCredits = true;
    state.hasComposer = true;
    state.answerCost = { modelName: 'Claude Sonnet 5.5', creditsPerAnswer: 54 };
    sendPrompt.mockClear();
    setChatInputValue.mockClear();
    localStorage.clear();
  });

  it('welcomes a user with no notebooks, stating their starting credits', () => {
    renderWelcome();
    expect(screen.getByTestId('new-user-welcome')).toBeInTheDocument();
    expect(screen.getByTestId('new-user-welcome-credits')).toHaveTextContent("You're starting with 9,982 credits.");
    expect(screen.getAllByTestId(/^new-user-welcome-prompt-/)).toHaveLength(3);
  });

  it('estimates how many answers the starting credits cover on the selected model, labelled as an estimate', () => {
    renderWelcome();
    expect(screen.getByTestId('new-user-welcome-answers-estimate')).toHaveTextContent(
      /^Estimate: about 180 answers on Claude Sonnet 5\.5\./
    );
  });

  it('shows no estimate when the selected model is not priced', () => {
    state.answerCost = null;
    renderWelcome();
    expect(screen.getByTestId('new-user-welcome-credits')).toBeInTheDocument();
    expect(screen.queryByTestId('new-user-welcome-answers-estimate')).not.toBeInTheDocument();
  });

  it('updates, hides and restores the estimate as the selected model changes', () => {
    const { rerender } = renderWelcome();
    const refresh = () =>
      rerender(
        <CssVarsProvider theme={appTheme}>
          <NewUserWelcome />
        </CssVarsProvider>
      );

    state.answerCost = { modelName: 'Mini', creditsPerAnswer: 15 };
    refresh();
    expect(screen.getByTestId('new-user-welcome-answers-estimate')).toHaveTextContent(
      /^Estimate: about 660 answers on Mini\./
    );

    state.answerCost = null;
    refresh();
    expect(screen.queryByTestId('new-user-welcome-answers-estimate')).not.toBeInTheDocument();
    expect(screen.getByTestId('new-user-welcome-credits')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^new-user-welcome-prompt-/)).toHaveLength(3);

    state.answerCost = { modelName: 'Claude Sonnet 5.5', creditsPerAnswer: 54 };
    refresh();
    expect(screen.getByTestId('new-user-welcome-answers-estimate')).toHaveTextContent(
      /^Estimate: about 180 answers on Claude Sonnet 5\.5\./
    );
  });

  it('does not interrupt a returning user who already has notebooks', () => {
    state.sessions = [{ id: 's1' }];
    renderWelcome();
    expect(screen.queryByTestId('new-user-welcome')).not.toBeInTheDocument();
  });

  it('starts a chat when a suggested prompt is clicked', async () => {
    renderWelcome();
    fireEvent.click(screen.getByTestId('new-user-welcome-prompt-0'));
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith(STARTER_PROMPTS[0].prompt, { respectBlockedState: true })
    );
    expect(setChatInputValue).not.toHaveBeenCalled();
  });

  it('leaves the prompt in the composer when the send is refused', async () => {
    sendPrompt.mockResolvedValueOnce(false);
    renderWelcome();
    fireEvent.click(screen.getByTestId('new-user-welcome-prompt-1'));
    await waitFor(() => expect(setChatInputValue).toHaveBeenCalledWith(STARTER_PROMPTS[1].prompt));
  });

  it('stays dismissed after the close button', () => {
    const { unmount } = renderWelcome();
    fireEvent.click(screen.getByTestId('new-user-welcome-dismiss'));
    expect(screen.queryByTestId('new-user-welcome')).not.toBeInTheDocument();
    unmount();
    renderWelcome();
    expect(screen.queryByTestId('new-user-welcome')).not.toBeInTheDocument();
  });

  it('links to the privacy page for data handling', () => {
    renderWelcome();
    const link = screen.getByTestId('new-user-welcome-privacy-link');
    expect(link.getAttribute('href')).toMatch(/\/privacy$/);
    expect(link.textContent).toBe('How your data is handled');
  });
});

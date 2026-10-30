import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ModelAnswerCost } from '@client/app/utils/creditEstimate';
import type { SignupGrant } from '@bike4mind/common';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';

const { state, sendPrompt, setChatInputValue, logEvent } = vi.hoisted(() => ({
  state: {
    sessions: [] as unknown[],
    isSuccess: true,
    isFetching: false,
    balance: 9982,
    liveBalance: null as number | null,
    enforceCredits: true,
    hasComposer: true,
    emailVerified: true,
    signupGrant: undefined as SignupGrant | undefined,
    answerCost: { modelName: 'Claude Sonnet 5.5', creditsPerAnswer: 54 } as ModelAnswerCost | null,
  },
  sendPrompt: vi.fn(() => Promise.resolve(true)),
  setChatInputValue: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({
    currentUser: {
      id: 'user-1',
      emailVerified: state.emailVerified,
      signupGrant: state.signupGrant,
      tags: state.emailVerified ? [] : [PENDING_FREE_CREDITS_TAG],
    },
  }),
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
  useSettingsFromServer: () => ({ data: undefined }),
}));
vi.mock('@client/app/hooks/useEffectiveCredits', () => ({
  useEffectiveCredits: (options?: { live?: boolean }) =>
    options?.live ? (state.liveBalance ?? state.balance) : state.balance,
}));
vi.mock('@client/app/hooks/useSelectedModelAnswerCost', () => ({
  useSelectedModelAnswerCost: () => state.answerCost,
}));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: logEvent }) }));
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
    state.liveBalance = null;
    state.enforceCredits = true;
    state.hasComposer = true;
    state.emailVerified = true;
    state.signupGrant = undefined;
    state.answerCost = { modelName: 'Claude Sonnet 5.5', creditsPerAnswer: 54 };
    sendPrompt.mockClear();
    setChatInputValue.mockClear();
    logEvent.mockClear();
    localStorage.clear();
  });

  it('welcomes a user with no notebooks, stating their starting credits', () => {
    renderWelcome();
    expect(screen.getByTestId('new-user-welcome')).toBeInTheDocument();
    expect(screen.getByTestId('new-user-welcome-credits')).toHaveTextContent("You're starting with 9,982 credits.");
    expect(screen.getAllByTestId(/^new-user-welcome-prompt-/)).toHaveLength(3);
    expect(logEvent).toHaveBeenCalledWith({ type: 'welcome_card_shown' });
    expect(logEvent).toHaveBeenCalledWith({ type: 'zero_state_shown', metadata: { surface: 'new_chat' } });
  });

  it('logs the impression once per user, not again on a later mount', () => {
    renderWelcome().unmount();
    logEvent.mockClear();
    renderWelcome();
    expect(screen.getByTestId('new-user-welcome')).toBeInTheDocument();
    expect(logEvent).not.toHaveBeenCalledWith({ type: 'welcome_card_shown' });
    expect(logEvent).not.toHaveBeenCalledWith({ type: 'zero_state_shown', metadata: { surface: 'new_chat' } });
  });

  it('invites a prompt, or typing below, while there are credits to send with', () => {
    renderWelcome();
    expect(screen.getByText(/or type your own below/i)).toBeInTheDocument();
  });

  it('drops "type your own below" and the starters at 0 credits, when the composer is replaced', () => {
    state.balance = 0;
    renderWelcome();
    expect(screen.getByTestId('new-user-welcome')).toBeInTheDocument();
    expect(screen.queryByText(/type your own below/i)).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/^new-user-welcome-prompt-/)).toHaveLength(0);
  });

  it('explains the empty card at 0 credits with no pending grant instead of showing only a title', () => {
    state.balance = 0;
    renderWelcome();
    expect(screen.getByTestId('new-user-welcome-out-of-credits').textContent).toBe("You're out of credits.");
    expect(screen.queryByTestId('new-user-welcome-credits')).not.toBeInTheDocument();
    expect(screen.getByTestId('new-user-welcome-privacy-link')).toBeInTheDocument();
  });

  it('hides starters when the live balance is exhausted while the displayed balance is frozen', () => {
    state.liveBalance = 0;
    renderWelcome();
    expect(screen.queryByText(/type your own below/i)).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/^new-user-welcome-prompt-/)).toHaveLength(0);
  });

  it('restores starters when live credits recover while the displayed balance is frozen at zero', () => {
    state.balance = 0;
    state.liveBalance = 1000;
    renderWelcome();
    expect(screen.getByText(/type your own below/i)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^new-user-welcome-prompt-/)).toHaveLength(3);
  });

  it('does not show the out-of-credits line while there is credit to start with', () => {
    renderWelcome();
    expect(screen.queryByTestId('new-user-welcome-out-of-credits')).not.toBeInTheDocument();
  });

  it('keeps the starters at 0 credits when credits are not enforced', () => {
    state.balance = 0;
    state.enforceCredits = false;
    renderWelcome();
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

  it('does not promise the maximum staged credits or answers before the tranche is assessed', () => {
    state.balance = 0;
    state.emailVerified = false;
    state.signupGrant = {
      stage: 'pending_email',
      signupCredits: 10000,
      unlockCredits: 20000,
      creditsReleased: 0,
      nextCondition: 'email_verification',
    };
    renderWelcome();
    expect(screen.getByTestId('new-user-welcome-credits')).toHaveTextContent(
      'Verify your email to unlock up to 10,000 credits now. The rest unlocks all at once when you subscribe, or all at once when you verify a card.'
    );
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
    expect(logEvent).toHaveBeenCalledWith({ type: 'welcome_card_clicked', metadata: { action: 'starter' } });
    expect(logEvent).toHaveBeenCalledWith({ type: 'starter_used', metadata: { starter: 0 } });
  });

  it('leaves the prompt in the composer when the send is refused', async () => {
    sendPrompt.mockResolvedValueOnce(false);
    renderWelcome();
    fireEvent.click(screen.getByTestId('new-user-welcome-prompt-1'));
    await waitFor(() => expect(setChatInputValue).toHaveBeenCalledWith(STARTER_PROMPTS[1].prompt));
    expect(logEvent).not.toHaveBeenCalledWith({ type: 'starter_used', metadata: { starter: 1 } });
  });

  it('stays dismissed after the close button', () => {
    const { unmount } = renderWelcome();
    fireEvent.click(screen.getByTestId('new-user-welcome-dismiss'));
    expect(screen.queryByTestId('new-user-welcome')).not.toBeInTheDocument();
    expect(logEvent).toHaveBeenCalledWith({ type: 'welcome_card_dismissed' });
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

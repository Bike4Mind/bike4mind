import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { estimateElevenLabsConversationalCost } from '@bike4mind/voice';
import { MAX_SESSION_SECONDS } from '@server/voice/voiceSessionLimits';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@client/app/hooks/data/settings', () => ({ useGetSettingsValue: () => true }));
const userState = { currentUser: { currentCredits: 1_000_000 } };
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => userState }));
vi.mock('@client/app/components/subscription/CreditsModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="credits-modal" /> : null),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const storeState = { phase: 'idle', errorMessage: null, start: vi.fn(), end: vi.fn() };
vi.mock('./useConversationalVoice', () => ({
  useConversationalVoiceStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}));

import ConversationalVoiceButton from './ConversationalVoiceButton';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderButton = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ConversationalVoiceButton currentSessionId={null} />
    </CssVarsProvider>
  );

describe('ConversationalVoiceButton cost hint', () => {
  beforeEach(() => {
    storeState.phase = 'idle';
    storeState.start.mockClear();
    userState.currentUser.currentCredits = 1_000_000;
  });

  it('describes the start control with the per-minute price the server bills', () => {
    renderButton();

    const perMinute = estimateElevenLabsConversationalCost(60).creditsToReserve;
    const button = screen.getByTestId('conversational-voice-btn');
    expect(button).toHaveAccessibleName(expect.stringMatching(/^Voice \(v2/));
    expect(button).toHaveAccessibleDescription(
      `About ${perMinute.toLocaleString('en-US')} credits/min, billed by the second`
    );
  });

  it('drops the price once a call is running', () => {
    storeState.phase = 'connected';
    renderButton();

    expect(screen.getByTestId('conversational-voice-btn')).not.toHaveAccessibleDescription(/credits\/min/);
  });

  it('shows the hold requirement and starts no call when the balance is below the hold', () => {
    const hold = estimateElevenLabsConversationalCost(MAX_SESSION_SECONDS).creditsToReserve;
    userState.currentUser.currentCredits = hold - 1;
    renderButton();

    const button = screen.getByTestId('conversational-voice-btn');
    expect(button).toHaveAccessibleDescription(
      `Needs ${hold.toLocaleString('en-US')} credits to start; unused credits are refunded`
    );
    fireEvent.click(button);
    expect(storeState.start).not.toHaveBeenCalled();
    expect(screen.getByTestId('credits-modal')).toBeInTheDocument();
  });

  it('shows the rate and starts the call when the balance covers the hold', () => {
    const hold = estimateElevenLabsConversationalCost(MAX_SESSION_SECONDS).creditsToReserve;
    userState.currentUser.currentCredits = hold;
    renderButton();

    const button = screen.getByTestId('conversational-voice-btn');
    expect(button).toHaveAccessibleDescription(/credits\/min, billed by the second/);
    fireEvent.click(button);
    expect(storeState.start).toHaveBeenCalledTimes(1);
  });
});

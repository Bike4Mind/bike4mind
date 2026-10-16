import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { estimateElevenLabsConversationalCost } from '@bike4mind/voice';
import { MAX_SESSION_SECONDS } from '@server/voice/voiceSessionLimits';
import { getThemeConfig } from '@client/app/utils/themes';

const settings: Record<string, boolean> = { voiceV2Enabled: true, enforceCredits: true };
vi.mock('@client/app/hooks/data/settings', () => ({ useGetSettingsValue: (key: string) => settings[key] }));
const userState: { currentUser: { currentCredits: number } | undefined } = {
  currentUser: { currentCredits: 1_000_000 },
};
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => userState }));
vi.mock('@client/app/components/subscription/CreditsModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="credits-modal" /> : null),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const storeState = { phase: 'idle', mode: null as string | null, errorMessage: null, start: vi.fn(), end: vi.fn() };
vi.mock('./useConversationalVoice', () => ({
  useConversationalVoiceStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
  isCallActivePhase: (phase: string) =>
    ['requesting-session', 'connecting', 'connected', 'reconnecting'].includes(phase),
  getCallFrequencyData: () => null,
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
    storeState.mode = null;
    storeState.start.mockClear();
    settings.enforceCredits = true;
    userState.currentUser = { currentCredits: 1_000_000 };
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
    userState.currentUser = { currentCredits: hold - 1 };
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
    userState.currentUser = { currentCredits: hold };
    renderButton();

    const button = screen.getByTestId('conversational-voice-btn');
    expect(button).toHaveAccessibleDescription(/credits\/min, billed by the second/);
    fireEvent.click(button);
    expect(storeState.start).toHaveBeenCalledTimes(1);
  });

  it('never gates the start when credit enforcement is off, whatever the balance', () => {
    settings.enforceCredits = false;
    userState.currentUser = { currentCredits: 0 };
    renderButton();

    const button = screen.getByTestId('conversational-voice-btn');
    expect(button).toHaveAccessibleDescription(/credits\/min, billed by the second/);
    fireEvent.click(button);
    expect(storeState.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('credits-modal')).not.toBeInTheDocument();
  });

  it('does not gate the start while the user is still loading', () => {
    userState.currentUser = undefined;
    renderButton();

    fireEvent.click(screen.getByTestId('conversational-voice-btn'));
    expect(storeState.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('credits-modal')).not.toBeInTheDocument();
  });

  it('keeps the label as the name and the price as the only description while the tooltip is open', async () => {
    renderButton();

    const button = screen.getByTestId('conversational-voice-btn');
    fireEvent.mouseOver(button);
    await screen.findByRole('tooltip');

    expect(button).toHaveAccessibleName(/^Voice \(v2 \S+ any model\)$/);
    expect(button).toHaveAccessibleDescription(/^About [\d,]+ credits\/min, billed by the second$/);
  });

  it('labels the button "End voice call" while a call is running', () => {
    storeState.phase = 'connected';
    renderButton();

    expect(screen.getByTestId('conversational-voice-btn')).toHaveAccessibleName('End voice call');
  });

  it('shows no status pill before a call', () => {
    renderButton();
    expect(screen.queryByTestId('conversational-voice-status')).toBeNull();
  });

  it('says who is talking in the status pill', () => {
    storeState.phase = 'connected';
    storeState.mode = 'listening';
    const { unmount } = renderButton();
    expect(screen.getByTestId('conversational-voice-status')).toHaveTextContent('Listening');
    unmount();
    storeState.mode = 'speaking';
    renderButton();
    expect(screen.getByTestId('conversational-voice-status')).toHaveTextContent('Speaking');
  });

  it('says it is connecting while the call starts', () => {
    storeState.phase = 'connecting';
    renderButton();
    expect(screen.getByTestId('conversational-voice-status')).toHaveTextContent('Connecting');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { estimateElevenLabsConversationalCost } from '@bike4mind/voice';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@client/app/hooks/data/settings', () => ({ useGetSettingsValue: () => true }));
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
});

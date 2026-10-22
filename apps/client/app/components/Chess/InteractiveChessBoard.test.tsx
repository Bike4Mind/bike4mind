import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import useChatActions from '@client/app/hooks/useChatActions';
import InteractiveChessBoard from './InteractiveChessBoard';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const renderBoard = () =>
  render(
    <Wrapper>
      <InteractiveChessBoard chessData={{ fen: DEFAULT_FEN }} sessionId="test-session" playerColor="w" />
    </Wrapper>
  );

// Selects e2 then plays e2-e4, mirroring a real player's two clicks.
const playE2E4 = () => {
  fireEvent.click(screen.getByTestId('chess-square-e2'));
  fireEvent.click(screen.getByTestId('chess-square-e4'));
};

describe('InteractiveChessBoard - chess is not gated by the blocked-send state', () => {
  afterEach(() => {
    useChatActions.setState({ sendPrompt: null });
  });

  it('reverts the optimistic move and unlocks the board when sendPrompt resolves false', async () => {
    const sendPrompt = vi.fn().mockResolvedValue(false);
    useChatActions.setState({ sendPrompt });
    renderBoard();

    playE2E4();

    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    // A refused send (in flight elsewhere, say) must not leave the board stuck: the
    // waiting indicator clears and the same move can be attempted again.
    await waitFor(() => expect(screen.queryByTestId('chess-submitting-indicator')).toBeNull());

    playE2E4();
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
  });

  it('does not pass a respectBlockedState option - chess sends exactly as before the gate existed', async () => {
    const sendPrompt = vi.fn().mockResolvedValue(true);
    useChatActions.setState({ sendPrompt });
    renderBoard();

    playE2E4();

    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    expect(sendPrompt).toHaveBeenCalledWith(expect.stringContaining('[FEN:'));
    // No second argument: chess must stay ungated regardless of the composer's
    // generating/reconnecting/uploading state.
    expect(sendPrompt.mock.calls[0]).toHaveLength(1);
  });
});

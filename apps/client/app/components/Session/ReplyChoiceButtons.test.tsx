import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SuggestedChoices } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import useChatActions from '@client/app/hooks/useChatActions';
import { useReplyChoices } from '@client/app/hooks/useReplyChoices';
import ReplyChoiceButtons from './ReplyChoiceButtons';
import NavigationButtons from './NavigationButtons';

const mockRecord = vi.fn();
vi.mock('@client/app/hooks/data/quests', () => ({
  recordReplyChoice: (...args: unknown[]) => mockRecord(...args),
}));
vi.mock('@client/app/hooks/useNavigationExecutor', () => ({ useNavigationExecutor: () => vi.fn() }));
vi.mock('@client/app/utils/navigationIntentSurface', () => ({ useIsIntentHidden: () => () => false }));

const appTheme = extendTheme({ ...getThemeConfig() });
const choices: SuggestedChoices = {
  options: [
    { label: 'Reformulate', description: 'Re-formulate with all three pools.' },
    { label: 'Extend', description: 'Extend the loaded brief.' },
  ],
};

const renderChoices = (suggestedChoices: SuggestedChoices = choices) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CssVarsProvider theme={appTheme}>
        <ReplyChoiceButtons questId="quest-1" sessionId="sess-1" suggestedChoices={suggestedChoices} />
      </CssVarsProvider>
    </QueryClientProvider>
  );

const sendPrompt = vi.fn(async (_prompt: string) => true);

beforeEach(() => {
  vi.clearAllMocks();
  useChatActions.setState({ sendPrompt });
  useReplyChoices.setState({ newestBySession: { 'sess-1': { questId: 'quest-1', suggestedChoices: choices } } });
});

describe('ReplyChoiceButtons', () => {
  it('numbers each option and shows its label and full description', () => {
    renderChoices();
    expect(screen.getByTestId('choice-btn-1').textContent).toContain('1');
    expect(screen.getByTestId('choice-btn-1-label').textContent).toBe('Reformulate');
    expect(screen.getByTestId('choice-btn-1-description').textContent).toBe('Re-formulate with all three pools.');
    expect(screen.getByTestId('choice-btn-2-label').textContent).toBe('Extend');
    expect(screen.getByText('press 1\u20132')).toBeTruthy();
    expect(screen.getByTestId('choice-btn-1').getAttribute('aria-label')).toBe(
      'Reformulate: Re-formulate with all three pools.'
    );
    expect(screen.getByTestId('choice-btn-2-description').textContent).toBe('Extend the loaded brief.');
  });

  it('sends the visible option text and records the pick once it was sent', async () => {
    renderChoices();
    fireEvent.click(screen.getByTestId('choice-btn-2'));

    // respectBlockedState: true is what scopes the blocked-send gate to the reply-choice path -
    // chess and other programmatic sendPrompt callers must stay ungated (see InteractiveChessBoard).
    expect(sendPrompt).toHaveBeenCalledWith('Extend: Extend the loaded brief.', { respectBlockedState: true });
    await waitFor(() =>
      expect(mockRecord).toHaveBeenCalledWith(expect.anything(), {
        sessionId: 'sess-1',
        questId: 'quest-1',
        suggestedChoices: choices,
        index: 1,
      })
    );
    expect(screen.getByTestId('choice-receipt-label').textContent).toBe('Extend');
    expect(screen.queryByTestId('choice-btn-1')).toBeNull();
  });

  it('picks an option with its digit key, but not while the user types', async () => {
    renderChoices();
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: '1' });
    expect(sendPrompt).not.toHaveBeenCalled();
    input.remove();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const dialogButton = document.createElement('button');
    dialog.appendChild(dialogButton);
    document.body.appendChild(dialog);
    fireEvent.keyDown(dialogButton, { key: '1' });
    expect(sendPrompt).not.toHaveBeenCalled();
    dialog.remove();

    fireEvent.keyDown(document.body, { key: '3' });
    expect(sendPrompt).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: '2' });
    expect(sendPrompt).toHaveBeenCalledWith('Extend: Extend the loaded brief.', { respectBlockedState: true });
    await waitFor(() => expect(mockRecord).toHaveBeenCalledTimes(1));
  });

  it('records nothing and stays clickable when the send is refused', async () => {
    sendPrompt.mockResolvedValueOnce(false);
    renderChoices();
    fireEvent.click(screen.getByTestId('choice-btn-2'));

    await waitFor(() => expect(screen.getByTestId('choice-btn-1')).not.toBeDisabled());
    expect(mockRecord).not.toHaveBeenCalled();
    expect(screen.queryByTestId('choice-receipt')).toBeNull();

    fireEvent.click(screen.getByTestId('choice-btn-1'));
    expect(sendPrompt).toHaveBeenLastCalledWith('Reformulate: Re-formulate with all three pools.', {
      respectBlockedState: true,
    });
    await waitFor(() => expect(mockRecord).toHaveBeenCalledTimes(1));
  });

  it('sends once on a double tap', async () => {
    renderChoices();
    const [first, second] = [screen.getByTestId('choice-btn-1'), screen.getByTestId('choice-btn-2')];
    fireEvent.click(first);
    fireEvent.click(first);
    fireEvent.click(second);

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockRecord).toHaveBeenCalledTimes(1));
  });

  it('shows a stored pick as a receipt, never the open list', () => {
    renderChoices({ ...choices, selectedIndex: 0 });
    expect(screen.getByTestId('choice-receipt-label').textContent).toBe('Reformulate');
    expect(screen.queryByTestId('choice-btn-1')).toBeNull();
  });

  it('is inert once a newer turn exists', () => {
    useReplyChoices.setState({ newestBySession: { 'sess-1': { questId: 'quest-2' } } });
    renderChoices();
    expect(screen.getByTestId('choice-btn-1')).toBeDisabled();
    fireEvent.click(screen.getByTestId('choice-btn-1'));
    fireEvent.keyDown(document.body, { key: '1' });
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});

describe('NavigationButtons with leading choices', () => {
  it('renders the choices above the navigation row', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CssVarsProvider theme={appTheme}>
          <NavigationButtons
            leading={<ReplyChoiceButtons questId="quest-1" sessionId="sess-1" suggestedChoices={choices} />}
            navigationIntents={[
              {
                viewId: 'opti.packing',
                label: 'Packing',
                description: 'd',
                navigationType: 'action',
                target: 'packing',
                reason: 'Open the packing console',
              },
            ]}
          />
        </CssVarsProvider>
      </QueryClientProvider>
    );
    const row = screen.getByRole('group', { name: 'Suggested next steps' });
    expect(row.querySelectorAll('button')).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Your call' }).querySelectorAll('button')).toHaveLength(2);
    expect(screen.getByText('Your call')).toBeTruthy();
    expect(screen.getByTestId('nav-btn-opti.packing')).toBeTruthy();
  });

  it('renders nothing with neither choices nor navigation', () => {
    const { container } = render(<NavigationButtons navigationIntents={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

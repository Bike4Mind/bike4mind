import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

const sendPrompt = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  useChatActions.setState({ sendPrompt });
  useReplyChoices.setState({ newestBySession: { 'sess-1': { questId: 'quest-1', suggestedChoices: choices } } });
});

describe('ReplyChoiceButtons', () => {
  it('numbers each option and labels it', () => {
    renderChoices();
    expect(screen.getByTestId('choice-btn-1').textContent).toBe('1Reformulate');
    expect(screen.getByTestId('choice-btn-2').textContent).toBe('2Extend');
  });

  it('sends the visible option text and records the pick', () => {
    renderChoices();
    fireEvent.click(screen.getByTestId('choice-btn-2'));

    expect(sendPrompt).toHaveBeenCalledWith('Extend: Extend the loaded brief.');
    expect(mockRecord).toHaveBeenCalledWith(expect.anything(), {
      sessionId: 'sess-1',
      questId: 'quest-1',
      suggestedChoices: choices,
      index: 1,
    });
  });

  it('sends once on a double tap', () => {
    renderChoices();
    fireEvent.click(screen.getByTestId('choice-btn-1'));
    fireEvent.click(screen.getByTestId('choice-btn-1'));
    fireEvent.click(screen.getByTestId('choice-btn-2'));

    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('marks a stored pick and disables the rest', () => {
    renderChoices({ ...choices, selectedIndex: 0 });
    expect(screen.getByTestId('choice-btn-1').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('choice-btn-2')).toBeDisabled();
  });

  it('is inert once a newer turn exists', () => {
    useReplyChoices.setState({ newestBySession: { 'sess-1': { questId: 'quest-2' } } });
    renderChoices();
    expect(screen.getByTestId('choice-btn-1')).toBeDisabled();
    fireEvent.click(screen.getByTestId('choice-btn-1'));
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});

describe('NavigationButtons with leading choices', () => {
  it('renders the choices and the navigation in one row', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CssVarsProvider theme={appTheme}>
          <NavigationButtons
            label="Your call"
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
    expect(row.querySelectorAll('button')).toHaveLength(3);
    expect(screen.getByText('Your call')).toBeTruthy();
    expect(screen.getByTestId('nav-btn-opti.packing')).toBeTruthy();
  });

  it('renders nothing with neither choices nor navigation', () => {
    const { container } = render(<NavigationButtons navigationIntents={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

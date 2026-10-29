import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ArenaNextResponse } from '@bike4mind/common';
import ArenaPage from './arena';

const state = vi.hoisted(() => ({
  next: { isPending: false, isError: false, error: null, data: undefined, refetch: vi.fn() } as {
    isPending: boolean;
    isError: boolean;
    error: Error | null;
    data: ArenaNextResponse | undefined;
    refetch: ReturnType<typeof vi.fn>;
  },
  mutate: vi.fn(),
  openBillingView: vi.fn(),
  enforceCredits: true,
  toastSuccess: vi.fn(),
}));

vi.mock('@client/app/hooks/data/preferenceArena', () => ({
  useArenaNextPair: () => state.next,
  useArenaVote: () => ({ mutate: state.mutate, isPending: false }),
}));
vi.mock('@client/app/components/subscription/BillingDeepLinkModals', () => ({
  useBillingView: () => ({ openView: state.openBillingView }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'enforceCredits' ? state.enforceCredits : undefined),
}));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@client/app/components/PreferenceArena/ArenaMarkdown', () => ({
  ArenaMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));
vi.mock('sonner', () => ({ toast: { success: state.toastSuccess, error: vi.fn() } }));

const theme = extendTheme({ ...getThemeConfig() });
const renderPage = () =>
  render(
    <CssVarsProvider theme={theme}>
      <ArenaPage />
    </CssVarsProvider>
  );

const PAIR_ID = 'a'.repeat(24);
const ready: ArenaNextResponse = {
  status: 'ready',
  pair: { pairId: PAIR_ID, prompt: 'Explain tides', taskType: 'qa', answerA: 'Moon pull', answerB: 'Wind' },
};

describe('ArenaPage', () => {
  beforeEach(() => {
    state.next = { isPending: false, isError: false, error: null, data: ready, refetch: vi.fn() };
    state.enforceCredits = true;
    state.mutate.mockReset();
    state.openBillingView.mockReset();
    state.toastSuccess.mockReset();
  });

  it('renders the prompt and both answers', () => {
    renderPage();
    expect(screen.getByTestId('arena-prompt')).toHaveTextContent('Explain tides');
    expect(screen.getByTestId('arena-answer-a')).toHaveTextContent('Answer A');
    expect(screen.getByTestId('arena-answer-a')).toHaveTextContent('Moon pull');
    expect(screen.getByTestId('arena-answer-b')).toHaveTextContent('Wind');
  });

  it.each([
    ['a', 'arena-vote-a-btn'],
    ['tie', 'arena-vote-tie-btn'],
    ['b', 'arena-vote-b-btn'],
  ])('posts choice %s', (choice, testId) => {
    renderPage();
    fireEvent.click(screen.getByTestId(testId));
    expect(state.mutate).toHaveBeenCalledWith({ pairId: PAIR_ID, choice }, expect.any(Object));
  });

  it('shows credits only when some were awarded, then fetches the next pair', () => {
    state.mutate.mockImplementation((_request, options) => options.onSuccess({ creditsAwarded: 3 }));
    renderPage();
    fireEvent.click(screen.getByTestId('arena-vote-a-btn'));
    expect(state.toastSuccess).toHaveBeenCalledWith('+3 credits');
    expect(state.next.refetch).toHaveBeenCalled();

    state.mutate.mockImplementation((_request, options) => options.onSuccess({ creditsAwarded: 0 }));
    fireEvent.click(screen.getByTestId('arena-vote-b-btn'));
    expect(state.toastSuccess).toHaveBeenLastCalledWith('Thanks for your feedback');
  });

  it('shows the empty state', () => {
    state.next.data = { status: 'empty' };
    renderPage();
    expect(screen.getByTestId('arena-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('arena-vote-a-btn')).not.toBeInTheDocument();
  });

  it('explains verification and opens the billing view for unverified accounts', () => {
    state.next.data = { status: 'ineligible', reason: 'unverified' };
    renderPage();
    expect(screen.getByTestId('arena-unverified')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('arena-unverified-verify-btn'));
    expect(state.openBillingView).toHaveBeenCalledWith('credits');
  });

  it('hides the verify button when credits are not enforced, since the billing modal cannot open', () => {
    state.enforceCredits = false;
    state.next.data = { status: 'ineligible', reason: 'unverified' };
    renderPage();
    expect(screen.getByTestId('arena-unverified')).toBeInTheDocument();
    expect(screen.queryByTestId('arena-unverified-verify-btn')).not.toBeInTheDocument();
  });

  it('shows a generic notice when blocked or disabled', () => {
    state.next.data = { status: 'ineligible', reason: 'blocked' };
    renderPage();
    expect(screen.getByTestId('arena-unavailable')).toBeInTheDocument();
  });
});

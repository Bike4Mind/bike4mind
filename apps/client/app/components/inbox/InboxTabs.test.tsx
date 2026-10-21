import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ index: 0, setIndex: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('@client/app/contexts/InboxContext', () => ({
  useInbox: () => ({ inboxIndex: h.index, setInboxIndex: h.setIndex }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'me', email: 'member@example.com' } }),
}));
vi.mock('@client/app/hooks/data/inbox', () => ({ useGetInbox: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/data/invites', () => ({ useGetUserInvites: () => ({ data: [] }) }));
vi.mock('./Messages', () => ({ default: () => <div data-testid="messages-panel" /> }));
vi.mock('./Invites', () => ({ default: () => <div data-testid="invites-panel" /> }));
vi.mock('@client/app/components/feedback/FeedbackRollupView', () => ({
  default: ({ from, to, showHeading }: { from: string; to: string; showHeading?: boolean }) => (
    <div data-testid="feedback-panel" data-show-heading={String(showHeading)}>{`${from}|${to}`}</div>
  ),
}));
vi.mock('@client/app/utils/feedbackRollupWindow', () => ({
  defaultFeedbackRollupWindow: () => ({ from: 'F', to: 'T' }),
}));

import InboxTabs from './InboxTabs';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTabs = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <InboxTabs />
    </CssVarsProvider>
  );

describe('InboxTabs', () => {
  beforeEach(() => {
    h.index = 0;
    h.setIndex.mockClear();
  });

  it('shows Messages first, unchanged', () => {
    renderTabs();
    expect(screen.getByTestId('inbox-tab-messages')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('messages-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('feedback-panel')).not.toBeInTheDocument();
  });

  it('selects the feedback tab and lazy-loads the rollup with the default window, under the tab label only', async () => {
    h.index = 2;
    renderTabs();
    expect(screen.getByTestId('inbox-tab-feedback')).toHaveAttribute('aria-selected', 'true');
    const panel = await screen.findByTestId('feedback-panel');
    expect(panel).toHaveTextContent('F|T');
    expect(panel).toHaveAttribute('data-show-heading', 'false');
  });

  it('switches to Your feedback on click', () => {
    renderTabs();
    fireEvent.click(screen.getByTestId('inbox-tab-feedback'));
    expect(h.setIndex).toHaveBeenCalledWith(2);
  });
});

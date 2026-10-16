import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ setOpen: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/contexts/ModalTriggerContext', () => ({
  useModalTrigger: () => ({ triggerModalByTag: vi.fn() }),
}));
vi.mock('@client/app/hooks/useAppVersion', () => ({ useAppVersion: () => ({ data: undefined }) }));
vi.mock('@client/app/hooks/data/opti', () => ({ useOptiAccess: () => false }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsTablet: () => false }));
vi.mock('@client/app/hooks/useGetLogo', () => ({ default: () => 'logo.png' }));
vi.mock('@client/app/contexts/InboxContext', () => ({ useInbox: { getState: () => ({ setOpen: h.setOpen }) } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'me', email: 'member@example.com' } }),
}));
vi.mock('@client/app/hooks/data/inbox', () => ({
  useGetInbox: () => ({ data: [{ userId: 'SYSTEM', readAt: null }] }),
}));
vi.mock('@client/app/hooks/data/invites', () => ({ useGetUserInvites: () => ({ data: [] }) }));
vi.mock('..', () => ({
  useNotebookLayout: (select: (s: unknown) => unknown) => select({ openSideNav: true, setOpenSideNav: vi.fn() }),
}));

import SideNavHeader from './Header';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('SideNavHeader inbox bell', () => {
  beforeEach(() => h.setOpen.mockClear());

  it('shows an Inbox button with the unread badge and opens the inbox on click', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <SideNavHeader />
      </CssVarsProvider>
    );
    const btn = screen.getByTestId('sidenav-header-inbox-btn');
    expect(btn).toHaveAttribute('aria-label', 'Inbox');
    expect(screen.getByTestId('inbox-badge')).toHaveAttribute('data-unread', 'true');
    fireEvent.click(btn);
    expect(h.setOpen).toHaveBeenCalledWith(true);
  });
});

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  setOpen: vi.fn(),
  setInboxIndex: vi.fn(),
  navigate: vi.fn(),
  openExternalLinkByKey: vi.fn(),
  optiVisible: false,
  inbox: [{ userId: 'SYSTEM', readAt: null }] as Array<{ userId: string; readAt: string | null }>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }));
vi.mock('@client/app/utils/externalLinks', () => ({ openExternalLinkByKey: h.openExternalLinkByKey }));
vi.mock('@client/app/contexts/ModalTriggerContext', () => ({
  useModalTrigger: () => ({ triggerModalByTag: vi.fn() }),
}));
vi.mock('@client/app/hooks/useAppVersion', () => ({ useAppVersion: () => ({ data: undefined }) }));
vi.mock('@client/app/hooks/data/opti', () => ({ useOptiVisible: () => h.optiVisible }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsTablet: () => false }));
vi.mock('@client/app/hooks/useGetLogo', () => ({ default: () => 'logo.png' }));
vi.mock('@client/app/contexts/InboxContext', () => ({
  useInbox: (select: (s: unknown) => unknown) => select({ setOpen: h.setOpen, setInboxIndex: h.setInboxIndex }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'me', email: 'member@example.com' } }),
}));
vi.mock('@client/app/hooks/data/inbox', () => ({
  useGetInbox: () => ({ data: h.inbox }),
}));
vi.mock('@client/app/hooks/data/invites', () => ({ useGetUserInvites: () => ({ data: [] }) }));
vi.mock('..', () => ({
  useNotebookLayout: (select: (s: unknown) => unknown) => select({ openSideNav: true, setOpenSideNav: vi.fn() }),
}));

import SideNavHeader from './Header';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('SideNavHeader inbox bell', () => {
  beforeEach(() => {
    h.setOpen.mockClear();
    h.setInboxIndex.mockClear();
    h.inbox = [{ userId: 'SYSTEM', readAt: null }];
  });

  const renderHeader = () =>
    render(
      <CssVarsProvider theme={appTheme}>
        <SideNavHeader />
      </CssVarsProvider>
    );

  it('announces unread items, shows the badge, and opens the inbox on Messages', () => {
    renderHeader();
    const btn = screen.getByTestId('sidenav-header-inbox-btn');
    expect(btn).toHaveAttribute('aria-label', 'Inbox, unread items');
    expect(screen.getByTestId('inbox-badge')).toHaveAttribute('data-unread', 'true');
    fireEvent.click(btn);
    expect(h.setInboxIndex).toHaveBeenCalledWith(0);
    expect(h.setOpen).toHaveBeenCalledWith(true);
    expect(h.setInboxIndex.mock.invocationCallOrder[0]).toBeLessThan(h.setOpen.mock.invocationCallOrder[0]);
  });

  it('is labelled plain Inbox when everything is read', () => {
    h.inbox = [{ userId: 'SYSTEM', readAt: '2026-01-01T00:00:00Z' }];
    renderHeader();
    expect(screen.getByTestId('sidenav-header-inbox-btn')).toHaveAttribute('aria-label', 'Inbox');
    expect(screen.getByTestId('inbox-badge')).toHaveAttribute('data-unread', 'false');
  });
});

describe('SideNavHeader logo target', () => {
  beforeEach(() => {
    h.navigate.mockClear();
    h.openExternalLinkByKey.mockClear();
    h.optiVisible = false;
  });

  const renderHeader = () =>
    render(
      <CssVarsProvider theme={appTheme}>
        <SideNavHeader />
      </CssVarsProvider>
    );

  it('opens the workspace when it is visible to the user', () => {
    h.optiVisible = true;
    renderHeader();
    fireEvent.click(screen.getByAltText(/logo$/));
    expect(h.navigate).toHaveBeenCalledWith({ to: '/opti' });
    expect(h.openExternalLinkByKey).not.toHaveBeenCalled();
  });

  it('opens the website instead when the workspace is hidden or not available', () => {
    renderHeader();
    fireEvent.click(screen.getByAltText(/logo$/));
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.openExternalLinkByKey).toHaveBeenCalledWith('website');
  });
});

import React, { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ISessionDocument } from '@bike4mind/common';

/**
 * Gating coverage for the sidenav session menu's "Send to Data Lake" item: it
 * must be hidden when EnableDataLakes is off, in BOTH menu variants (the
 * default sidenav row menu and the location="header" dropdown), matching the
 * other gated entry points (SessionExportMenu, MessageContent).
 */

// --- contexts / data hooks ---------------------------------------------------
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'user-1' }, isAdmin: false }),
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: null }),
}));
const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
vi.mock('@client/app/hooks/data/sessions', () => ({
  useAutoRenameSession: () => mutation(),
  useCloneSession: () => mutation(),
  useCopySessionAsMarkdown: () => mutation(),
  useDeleteSession: () => mutation(),
  useDownloadSession: () => mutation(),
  useExportSessionToExcel: () => mutation(),
  useExportSessionToWord: () => mutation(),
  useSendSessionToDataLake: () => mutation(),
  useSummarizeSession: () => mutation(),
  useToggleFavoriteSession: () => mutation(),
  useUpdateSessionTags: () => mutation(),
}));
vi.mock('@client/app/hooks/data/agentProactiveMessaging', () => ({
  useTriggerProactiveMessages: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/useUnreadProactiveMessages', () => ({
  useSessionUnreadCount: () => 0,
}));
vi.mock('@client/app/hooks/useJobStatus', () => ({
  useJobStatus: () => ({ isJobRunning: () => false, getRunningJobs: () => [] }),
}));
vi.mock('@client/app/components/Project/ProjectAddToModal', () => ({
  useProjectAddToModal: () => ({ openModal: vi.fn() }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

// --- heavy child components (not under test) --------------------------------
vi.mock('@client/app/components/common/SessionMetadataModal', () => ({ default: () => null }));
vi.mock('@client/app/components/common/ShareModal', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/RenameInput', () => ({ default: () => null }));
vi.mock('@client/app/components/ConfirmActionModal', () => ({ default: () => null }));
vi.mock('@client/app/components/ProfileModal/NotebookCurationModal', () => ({ default: () => null }));

// --- the flag under test -----------------------------------------------------
const isFeatureEnabled = vi.fn();
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled }),
}));

import SidenavItem from './SidenavItem';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// currentUser.id === session.userId, so canUpdate/canShare resolve as owner.
const session = {
  id: 'session-1',
  name: 'Test Session',
  userId: 'user-1',
  users: [],
} as unknown as ISessionDocument;

function renderAndOpenMenu(location?: 'header') {
  render(
    <TestWrapper>
      <SidenavItem session={session} location={location} />
    </TestWrapper>
  );
  fireEvent.click(screen.getByTestId('sidenav-item-menu-btn'));
}

describe.each([
  ['default sidenav menu', undefined],
  ['header dropdown menu', 'header'],
] as const)('SidenavItem %s - EnableDataLakes gating', (_label, location) => {
  beforeEach(() => {
    isFeatureEnabled.mockReset();
    isFeatureEnabled.mockReturnValue(true);
  });

  it('shows the Send to Data Lake item when the feature is on', () => {
    renderAndOpenMenu(location);

    expect(screen.getByTestId('sidenav-item-menuitem-send-datalake')).toBeInTheDocument();
  });

  it('hides the Send to Data Lake item when the feature is off', () => {
    isFeatureEnabled.mockImplementation((key: string) => key !== 'EnableDataLakes');

    renderAndOpenMenu(location);

    expect(screen.queryByTestId('sidenav-item-menuitem-send-datalake')).not.toBeInTheDocument();
  });

  it('keeps the neighboring export actions available when the feature is off', () => {
    isFeatureEnabled.mockImplementation((key: string) => key !== 'EnableDataLakes');

    renderAndOpenMenu(location);

    expect(screen.getByTestId('sidenav-item-menuitem-export-excel')).toBeInTheDocument();
    expect(screen.getByTestId('sidenav-item-menuitem-export-word')).toBeInTheDocument();
  });

  // Parity: the menu is identical for every notebook (favorites included). There
  // is no longer a slimmed-down variant - the former `disableExportOps` flag,
  // which the Favorites list set to hide Download/Copy/Export/Send, was removed
  // so all rows expose the full export action set.
  it('shows the full export action set (download, copy-markdown, excel, word)', () => {
    renderAndOpenMenu(location);

    expect(screen.getByText('notebooks.download')).toBeInTheDocument();
    expect(screen.getByText('Copy as Markdown')).toBeInTheDocument();
    expect(screen.getByTestId('sidenav-item-menuitem-export-excel')).toBeInTheDocument();
    expect(screen.getByTestId('sidenav-item-menuitem-export-word')).toBeInTheDocument();
    expect(screen.getByTestId('sidenav-item-menuitem-send-datalake')).toBeInTheDocument();
  });
});

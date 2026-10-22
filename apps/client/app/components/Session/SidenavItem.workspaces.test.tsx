import React, { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { WORKSPACE_SURFACES, type ISessionDocument } from '@bike4mind/common';

/**
 * The session menu's workspace actions: "Clone into" (falls back to a plain Clone when there is no
 * other workspace) and the owner-only "Move to" with its confirm dialog, in both menu variants.
 */
const main = WORKSPACE_SURFACES[0];
const opti = WORKSPACE_SURFACES[1];

const h = vi.hoisted(() => ({
  clone: { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false },
  move: { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false },
  navigate: vi.fn(),
  targets: { current: undefined, copyTargets: [], moveTargets: [] } as Record<string, unknown>,
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'user-1' }, isAdmin: false }),
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: 'session-1' }),
}));
const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
vi.mock('@client/app/hooks/data/sessions', () => ({
  useAutoRenameSession: () => mutation(),
  useCloneSession: () => h.clone,
  useCopySessionAsMarkdown: () => mutation(),
  useDeleteSession: () => mutation(),
  useDownloadSession: () => mutation(),
  useExportSessionToExcel: () => mutation(),
  useExportSessionToWord: () => mutation(),
  useExportSessionToHtml: () => mutation(),
  useMoveSession: () => h.move,
  useSendSessionToDataLake: () => mutation(),
  useSummarizeSession: () => mutation(),
  useToggleFavoriteSession: () => mutation(),
  useUpdateSessionTags: () => mutation(),
}));
vi.mock('@client/app/hooks/useWorkspaceTargets', () => ({ useWorkspaceTargets: () => h.targets }));
vi.mock('@client/app/hooks/data/agentProactiveMessaging', () => ({
  useTriggerProactiveMessages: () => mutation(),
}));
vi.mock('@client/app/hooks/useUnreadProactiveMessages', () => ({ useSessionUnreadCount: () => 0 }));
vi.mock('@client/app/hooks/useJobStatus', () => ({
  useJobStatus: () => ({ isJobRunning: () => false, getRunningJobs: () => [] }),
}));
vi.mock('@client/app/components/Project/ProjectAddToModal', () => ({
  useProjectAddToModal: () => ({ openModal: vi.fn() }),
}));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: () => true }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }));
vi.mock('@client/app/components/common/SessionMetadataModal', () => ({ default: () => null }));
vi.mock('@client/app/components/common/ShareModal', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/RenameInput', () => ({ default: () => null }));
vi.mock('@client/app/components/ConfirmActionModal', () => ({ default: () => null }));
vi.mock('@client/app/components/ProfileModal/NotebookCurationModal', () => ({ default: () => null }));

import SidenavItem from './SidenavItem';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const session = { id: 'session-1', name: 'Test Session', userId: 'user-1', users: [] } as unknown as ISessionDocument;

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
] as const)('SidenavItem %s - workspace actions', (_label, location) => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.targets = { current: main, copyTargets: [main, opti], moveTargets: [opti] };
  });

  it('shows a plain Clone and no Move to when there is no other workspace', () => {
    h.targets = { current: main, copyTargets: [main], moveTargets: [] };
    renderAndOpenMenu(location);

    expect(screen.getByTestId('sidenav-item-menuitem-clone')).toBeInTheDocument();
    expect(screen.queryByTestId('session-menu-clone-into-label')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-menu-move-to-label')).not.toBeInTheDocument();
  });

  // A session in an unregistered surface gets no targets at all: clone still works, in place.
  it('keeps the plain Clone for a session whose surface is not movable', () => {
    h.targets = { current: undefined, copyTargets: [], moveTargets: [] };
    renderAndOpenMenu(location);

    fireEvent.click(screen.getByTestId('sidenav-item-menuitem-clone'));

    expect(h.clone.mutate).toHaveBeenCalledWith('session-1');
  });

  it('lists the clone targets with the current workspace first', () => {
    renderAndOpenMenu(location);

    const items = [
      screen.getByTestId('session-menu-clone-into-main'),
      screen.getByTestId('session-menu-clone-into-opti'),
    ];
    expect(items[0].compareDocumentPosition(items[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('sidenav-item-menuitem-clone')).not.toBeInTheDocument();
  });

  it('clones in place when the current workspace is picked', () => {
    renderAndOpenMenu(location);

    fireEvent.click(screen.getByTestId('session-menu-clone-into-main'));

    expect(h.clone.mutate).toHaveBeenCalledWith('session-1');
  });

  it('clones into another workspace by naming it', () => {
    renderAndOpenMenu(location);

    fireEvent.click(screen.getByTestId('session-menu-clone-into-opti'));

    expect(h.clone.mutate).toHaveBeenCalledWith({ sessionId: 'session-1', targetSurface: 'opti' });
  });

  it('hides Move to when the hook offers no move target (e.g. not the owner)', () => {
    h.targets = { current: main, copyTargets: [main, opti], moveTargets: [] };
    renderAndOpenMenu(location);

    expect(screen.queryByTestId('session-menu-move-to-label')).not.toBeInTheDocument();
  });

  it('confirms before moving, then moves and follows the open notebook to its new home', async () => {
    h.move.mutateAsync.mockResolvedValue({ id: 'session-1', surface: 'opti' });
    renderAndOpenMenu(location);

    fireEvent.click(screen.getByTestId('session-menu-move-to-opti'));
    expect(h.move.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('move-session-modal')).toHaveTextContent('will be hidden until you move it back');
    expect(screen.getByTestId('move-session-modal')).toHaveTextContent('People it is shared with will see it move');

    fireEvent.click(screen.getByTestId('move-session-modal-confirm-btn'));

    await waitFor(() =>
      expect(h.move.mutateAsync).toHaveBeenCalledWith({ sessionId: 'session-1', targetSurface: 'opti' })
    );
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith({ href: '/opti?mode=canvas&session=session-1' }));
  });

  it('does nothing when the move is cancelled', async () => {
    renderAndOpenMenu(location);

    fireEvent.click(screen.getByTestId('session-menu-move-to-opti'));
    fireEvent.click(screen.getByTestId('move-session-modal-cancel-btn'));

    await waitFor(() => expect(screen.queryByTestId('move-session-modal')).not.toBeInTheDocument());
    expect(h.move.mutateAsync).not.toHaveBeenCalled();
  });
});

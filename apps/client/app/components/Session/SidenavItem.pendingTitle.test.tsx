import React, { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ISessionDocument } from '@bike4mind/common';

/** The "Naming chat..." placeholder must give way to the real name once its window closes. */

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
  useMoveSession: () => mutation(),
  useExportSessionToExcel: () => mutation(),
  useExportSessionToWord: () => mutation(),
  useExportSessionToHtml: () => mutation(),
  useSendSessionToDataLake: () => mutation(),
  useSummarizeSession: () => mutation(),
  useToggleFavoriteSession: () => mutation(),
  useUpdateSessionTags: () => mutation(),
}));
vi.mock('@client/app/hooks/useWorkspaceTargets', () => ({
  useWorkspaceTargets: () => ({ current: undefined, copyTargets: [], moveTargets: [] }),
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

const isFeatureEnabled = vi.fn();
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled }),
}));

import SidenavItem from './SidenavItem';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('SidenavItem - pending auto-title label', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isFeatureEnabled.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops the placeholder when the window closes even if the title never lands', () => {
    const session = {
      id: 'session-1',
      name: 'New Notebook',
      userId: 'user-1',
      users: [],
      firstCreated: new Date(Date.now() - 60_000),
    } as unknown as ISessionDocument;

    render(
      <TestWrapper>
        <SidenavItem session={session} />
      </TestWrapper>
    );
    expect(screen.getByText('Naming chat...')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(61_000);
    });

    expect(screen.queryByText('Naming chat...')).not.toBeInTheDocument();
    expect(screen.getByText('New Notebook')).toBeInTheDocument();
  });
});

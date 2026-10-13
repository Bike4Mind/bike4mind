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
import { useStreamingState } from '@client/app/hooks/useStreamingState';

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
    act(() => useStreamingState.getState().resetStreaming('session-1'));
  });

  const freshSession = (extra: Partial<ISessionDocument> = {}) =>
    ({
      id: 'session-1',
      name: 'New Notebook',
      userId: 'user-1',
      users: [],
      firstCreated: new Date(Date.now() - 60_000),
      ...extra,
    }) as unknown as ISessionDocument;

  const renderItem = (session: ISessionDocument) =>
    render(
      <TestWrapper>
        <SidenavItem session={session} />
      </TestWrapper>
    );

  it('keeps the default name on an empty notebook, which is never auto-named', () => {
    renderItem(freshSession({ messageCount: 0 }));

    expect(screen.queryByText('Naming chat...')).not.toBeInTheDocument();
    expect(screen.getByText('New Notebook')).toBeInTheDocument();
  });

  it('shows the placeholder once a first prompt is in flight, and keeps it after the stream ends', () => {
    renderItem(freshSession());
    expect(screen.queryByText('Naming chat...')).not.toBeInTheDocument();

    act(() => useStreamingState.getState().startStreaming('session-1'));
    expect(screen.getByText('Naming chat...')).toBeInTheDocument();

    // The title lands after the reply, so the end of the stream alone must not drop the label.
    act(() => useStreamingState.getState().completeStreaming('session-1'));
    expect(screen.getByText('Naming chat...')).toBeInTheDocument();
  });

  it('shows the placeholder for a notebook that already has a message', () => {
    renderItem(freshSession({ messageCount: 1 }));
    expect(screen.getByText('Naming chat...')).toBeInTheDocument();
  });

  it('drops the placeholder when the window closes even if the title never lands', () => {
    renderItem(freshSession({ lastUsedModel: 'some-model' }));
    expect(screen.getByText('Naming chat...')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(61_000);
    });

    expect(screen.queryByText('Naming chat...')).not.toBeInTheDocument();
    expect(screen.getByText('New Notebook')).toBeInTheDocument();
  });
});

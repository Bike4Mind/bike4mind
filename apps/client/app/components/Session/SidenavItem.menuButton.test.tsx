import React, { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ISessionDocument } from '@bike4mind/common';

const jobRunning = vi.hoisted(() => ({ value: false }));

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
  useTriggerProactiveMessages: () => mutation(),
}));
vi.mock('@client/app/hooks/useUnreadProactiveMessages', () => ({
  useSessionUnreadCount: () => 0,
}));
vi.mock('@client/app/hooks/useJobStatus', () => ({
  useJobStatus: () => ({ isJobRunning: () => jobRunning.value, getRunningJobs: () => [] }),
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
vi.mock('@client/app/components/common/SessionMetadataModal', () => ({ default: () => null }));
vi.mock('@client/app/components/common/ShareModal', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/RenameInput', () => ({ default: () => null }));
vi.mock('@client/app/components/ConfirmActionModal', () => ({ default: () => null }));
vi.mock('@client/app/components/ProfileModal/NotebookCurationModal', () => ({ default: () => null }));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: () => true }),
}));

import SidenavItem from './SidenavItem';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const session = {
  id: 'session-1',
  name: 'A notebook',
  userId: 'user-1',
  users: [],
  firstCreated: new Date('2020-01-01T00:00:00Z'),
  messageCount: 2,
} as unknown as ISessionDocument;

const renderItem = () =>
  render(
    <TestWrapper>
      <SidenavItem session={session} />
    </TestWrapper>
  );

describe('SidenavItem menu button class', () => {
  beforeEach(() => {
    jobRunning.value = false;
  });

  it('carries item-actions alone while the session is idle', () => {
    renderItem();
    const classes = screen.getByTestId('sidenav-item-menu-btn').className.split(/\s+/);
    expect(classes).toContain('item-actions');
    expect(classes).not.toContain('isProcessing');
  });

  it('adds isProcessing while a background job runs for the session', () => {
    jobRunning.value = true;
    renderItem();
    const classes = screen.getByTestId('sidenav-item-menu-btn').className.split(/\s+/);
    expect(classes).toContain('item-actions');
    expect(classes).toContain('isProcessing');
  });
});

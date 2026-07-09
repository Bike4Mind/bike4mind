import React, { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IChatHistoryItem } from '@bike4mind/common';

/**
 * Gating coverage for the per-reply "Send to Data Lake" menu item: it must be
 * hidden when EnableDataLakes is off (otherwise it opens the app-level modal
 * into a dead-end empty state), and stay functional when the feature is on.
 *
 * MessageContent is a heavy component; everything around the actions menu is
 * mocked to a stub so the test exercises only the real menu markup.
 */

// --- context / data hooks -------------------------------------------------
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'user-1' } }),
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: null, setCurrentSession: vi.fn() }),
  useWorkBenchFiles: () => [],
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/contexts/LLMContext', () => {
  const state = { researchMode: { enabled: false }, setLLM: vi.fn() };
  return { useLLM: (selector: (s: typeof state) => unknown) => selector(state) };
});
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction: vi.fn(() => vi.fn()) }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useForkSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSnipSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/quests', () => ({
  useGetQuest: () => ({ data: undefined, isLoading: false }),
  useUpdateQuest: () => Object.assign(vi.fn(), { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFilesByQuestId: () => ({ data: [] }),
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [] }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({ data: [] }),
}));
vi.mock('@client/app/hooks/usePublishShare', () => ({
  usePublishShare: () => ({ publishAndShare: vi.fn(), modal: null }),
}));
vi.mock('@client/app/hooks/useMessageEditMode', () => {
  const state = { triggerEdit: vi.fn() };
  return { useMessageEditMode: (selector: (s: typeof state) => unknown) => selector(state) };
});
vi.mock('@client/app/components/Session/PromptMetaInspector', () => {
  const state = { setPromptMeta: vi.fn() };
  return { usePromptMetaInspector: (selector: (s: typeof state) => unknown) => selector(state) };
});
vi.mock('@client/app/hooks/useSubscribeChatCompletion', () => ({
  useSubscribeChatCompletion: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

// --- utils with API/server dependencies ------------------------------------
vi.mock('@client/app/utils/fabFileUtils', () => ({
  saveToFileAndWorkbench: vi.fn(),
}));
vi.mock('@client/app/utils/publishApi', () => ({
  replyPublisher: vi.fn(() => vi.fn()),
}));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: (selector: (s: { selectedAccount: null }) => unknown) => selector({ selectedAccount: null }),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// --- heavy child components (not under test) --------------------------------
vi.mock('@client/app/components/Session/PromptReplies', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/UserPrompt', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/CopyTextButton', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/ToolsUsed', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/AgentExecution/ReasoningDisclosure', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/AgentExecution/AutoRouteBadge', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/ResearchModeResponseDisplay', () => ({ default: () => null }));
vi.mock('@client/app/components/ConfirmActionModal', () => ({ default: () => null }));
vi.mock('@client/app/components/BugReportModal', () => ({ default: () => null }));
vi.mock('@client/app/components/ProfileModal/ContentPreviewModal', () => ({ default: () => null }));
vi.mock('../common/DownloadMenu', () => ({ default: () => null, downloadFile: vi.fn() }));

// --- the flag under test ----------------------------------------------------
// Default (flag on) is established in beforeEach; tests override per-case.
const isFeatureEnabled = vi.fn();
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled }),
}));

import { useSendToDataLakeStore } from '@client/app/stores/useSendToDataLakeStore';
import MessageContent from './MessageContent';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

const messageData = {
  id: 'quest-1',
  prompt: 'hello',
  replies: ['a reply worth saving'],
  status: 'done',
} as unknown as IChatHistoryItem;

function renderAndOpenActionsMenu() {
  render(
    <TestWrapper>
      <MessageContent
        sessionId="session-1"
        messageData={messageData}
        index={0}
        onDelete={vi.fn()}
        onPinToggle={vi.fn()}
        onSendMessage={vi.fn()}
        isLastMessage={false}
        model="gpt-4o"
        totalMessages={1}
        canUseAdminTools={false}
      />
    </TestWrapper>
  );
  fireEvent.click(screen.getByTestId('message-actions-menu-btn'));
}

describe('MessageContent actions menu - EnableDataLakes gating', () => {
  beforeEach(() => {
    isFeatureEnabled.mockReset();
    isFeatureEnabled.mockReturnValue(true);
    useSendToDataLakeStore.setState({ isOpen: false });
  });

  it('shows the Send to Data Lake item when the feature is on', () => {
    renderAndOpenActionsMenu();

    expect(screen.getByTestId('message-send-to-datalake')).toBeInTheDocument();
  });

  it('hides the Send to Data Lake item when the feature is off', () => {
    isFeatureEnabled.mockImplementation((key: string) => key !== 'EnableDataLakes');

    renderAndOpenActionsMenu();

    expect(screen.queryByTestId('message-send-to-datalake')).not.toBeInTheDocument();
  });

  it('keeps the neighboring actions available when the feature is off', () => {
    isFeatureEnabled.mockImplementation((key: string) => key !== 'EnableDataLakes');

    renderAndOpenActionsMenu();

    // Share sits right after the gated item; Delete closes the menu - both must survive.
    expect(screen.getByTestId('message-share-reply')).toBeInTheDocument();
    expect(screen.getByText('Toggle Code View')).toBeInTheDocument();
    expect(screen.getByText(/^Save as/)).toBeInTheDocument();
  });

  it('still opens the Send to Data Lake modal from the item when the feature is on', () => {
    renderAndOpenActionsMenu();

    fireEvent.click(screen.getByTestId('message-send-to-datalake'));

    expect(useSendToDataLakeStore.getState().isOpen).toBe(true);
  });
});

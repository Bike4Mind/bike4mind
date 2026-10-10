import React, { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IChatHistoryItem } from '@bike4mind/common';

/**
 * The PR's headline behavior - a persisted fallbackInfo rendering as a note on reload - lives
 * entirely in the `<FallbackModelNote fallbackInfo={messageData.fallbackInfo ...} />` wiring in
 * MessageContent. FallbackModelNote.test.tsx only renders that component in isolation, so it
 * cannot catch a regression that drops or misroutes the prop in MessageContent itself.
 */

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'user-1', organizationId: 'org_42', showCreditsUsed: false } }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { contextTelemetryLevel: 'basic' } }),
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
  useGetSession: () => ({ data: undefined }),
  useForkSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSnipSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/quests', () => ({
  useGetQuest: () => ({ data: undefined, isLoading: false }),
  useUpdateQuest: () => Object.assign(vi.fn(), { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/fabFiles', () => ({ useGetFabFilesByQuestId: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/data/feedback', () => ({
  useGetFeedbackBySessionId: () => ({ data: [] }),
  feedbackSessionQueryKey: (sessionId: string, userId: string | undefined) => [
    'feedback',
    'session',
    sessionId,
    userId,
  ],
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/data/settings', () => ({ useSettingsFromServer: () => ({ data: [] }) }));
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
vi.mock('@client/app/hooks/useSubscribeChatCompletion', () => ({ useSubscribeChatCompletion: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/utils/fabFileUtils', () => ({ saveToFileAndWorkbench: vi.fn() }));
vi.mock('@client/app/utils/publishApi', () => ({ replyPublisher: vi.fn(() => vi.fn()) }));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: (selector: (s: { selectedAccount: null }) => unknown) => selector({ selectedAccount: null }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: () => false }),
}));

vi.mock('@client/app/components/Session/PromptReplies', () => ({
  default: () => <div data-testid="reply-body-marker">the streaming answer</div>,
}));
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

import MessageContent from './MessageContent';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

const baseMessage = {
  id: 'quest-1',
  prompt: 'hello',
  replies: ['the streaming answer'],
  status: 'done',
} as unknown as IChatHistoryItem;

const renderMessage = (fallbackInfo: IChatHistoryItem['fallbackInfo'], type?: IChatHistoryItem['type']) =>
  render(
    <TestWrapper>
      <MessageContent
        sessionId="session-1"
        messageData={{ ...baseMessage, fallbackInfo, type }}
        index={0}
        onDelete={vi.fn()}
        onPinToggle={vi.fn()}
        onSendMessage={vi.fn()}
        isLastMessage
        model="gpt-4o"
        totalMessages={1}
        canUseAdminTools={false}
      />
    </TestWrapper>
  );

describe('MessageContent - fallback note reload wiring', () => {
  it('renders the fallback note when the reloaded quest carries fallbackInfo', () => {
    renderMessage({
      primaryModel: 'gpt-4o',
      primaryModelName: 'GPT-4o',
      fallbackModel: 'claude-sonnet-5',
      fallbackModelName: 'Claude Sonnet 5',
      reason: 'rate limited',
    });

    expect(screen.getByTestId('fallback-model-note-chip')).toBeInTheDocument();
  });

  it('renders no fallback note on an error turn even if a stale fallbackInfo was persisted', () => {
    renderMessage(
      {
        primaryModel: 'gpt-4o',
        primaryModelName: 'GPT-4o',
        fallbackModel: 'claude-sonnet-5',
        fallbackModelName: 'Claude Sonnet 5',
      },
      'error'
    );

    expect(screen.queryByTestId('fallback-model-note-chip')).toBeNull();
  });

  it('renders no fallback note when the quest has no fallbackInfo', () => {
    renderMessage(undefined);

    expect(screen.queryByTestId('fallback-model-note-chip')).toBeNull();
  });
});

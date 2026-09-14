import React, { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IChatHistoryItem } from '@bike4mind/common';

/**
 * The whole point of this PR: the rapid-reply acknowledgement must render ABOVE the
 * streaming reply body, because it is produced first. It used to live in
 * SessionMiddle's footer, which sits after the chat-history list in the DOM, so it
 * appeared below the answer it was acknowledging.
 *
 * The assertion is on document order rather than on the bubble merely existing -
 * testing the bubble in isolation cannot catch a regression that moves this JSX
 * below the reply body, which is exactly the bug being fixed.
 *
 * PromptReplies is stubbed to a marker instead of null (as the sibling gating test
 * does) precisely so there is something to compare position against; a null stub
 * makes any order assertion vacuous.
 */

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'user-1', organizationId: 'org_42', showCreditsUsed: false } }),
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
vi.mock('@client/app/hooks/data/fabFiles', () => ({ useGetFabFilesByQuestId: () => ({ data: [] }) }));
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

// The reply body: a marker, so document order against the bubble is assertable.
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

const streamingMessage = {
  id: 'quest-1',
  prompt: 'hello',
  replies: ['the streaming answer'],
  status: 'running',
} as unknown as IChatHistoryItem;

// 'completed' is what the wire actually carries (pages/api/ai/rapid-reply.ts hardcodes it).
const chatCompletion = {
  completed: false,
  stopped: false,
  statusMessage: 'Running...',
  rapidReply: { content: 'Give me a moment.', status: 'completed' },
} as never;

const renderStreamingMessage = (completion: unknown) =>
  render(
    <TestWrapper>
      <MessageContent
        sessionId="session-1"
        messageData={streamingMessage}
        index={0}
        onDelete={vi.fn()}
        onPinToggle={vi.fn()}
        onSendMessage={vi.fn()}
        isLastMessage
        model="gpt-4o"
        totalMessages={1}
        canUseAdminTools={false}
        chatCompletion={completion as never}
      />
    </TestWrapper>
  );

describe('MessageContent - rapid reply placement', () => {
  it('renders the rapid reply before the reply body in document order', () => {
    renderStreamingMessage(chatCompletion);

    const bubble = screen.getByTestId('rapid-reply-container');
    const body = screen.getByTestId('reply-body-marker');

    // DOCUMENT_POSITION_FOLLOWING === 4: `body` comes after `bubble`.
    expect(bubble.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Guards the other half of the placement: only the streaming item is handed a
  // chatCompletion, so every other message must render no bubble at all.
  it('renders no bubble for a message without a chat completion', () => {
    renderStreamingMessage(undefined);

    expect(screen.queryByTestId('rapid-reply-container')).toBeNull();
    expect(screen.getByTestId('reply-body-marker')).toBeInTheDocument();
  });
});

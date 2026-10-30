import React, { type ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IChatHistoryItem } from '@bike4mind/common';

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
    computeItemKey,
    firstItemIndex = 0,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => ReactNode;
    computeItemKey: (index: number, item: unknown) => string;
    firstItemIndex?: number;
  }) => (
    <div>
      {data.map((item, i) => (
        <div key={computeItemKey(firstItemIndex + i, item)}>{itemContent(firstItemIndex + i, item)}</div>
      ))}
    </div>
  ),
}));
vi.mock('./ImageContainer', () => ({
  default: ({ src }: { src: string }) => <img data-testid="reply-image-loaded" src={src} alt="" />,
}));
vi.mock('@client/app/contexts/ApiContext', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, api: { post: vi.fn(), get: vi.fn() } };
});
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'user-1', organizationId: 'org_42', showCreditsUsed: false } }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { contextTelemetryLevel: 'basic' } }),
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: 'session-1', currentSession: null, setCurrentSession: vi.fn() }),
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
vi.mock('@client/app/hooks/useWorkspaceTargets', () => ({
  surfaceRouteExists: () => true,
  useWorkspacePresenter: () => (surface: unknown) => surface,
  useWorkspaceTargets: () => ({ current: undefined, copyTargets: [], moveTargets: [] }),
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
vi.mock('@client/app/hooks/data/settings', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSettingsFromServer: () => ({ data: [] }),
}));
vi.mock('@client/app/hooks/usePublishShare', () => ({
  usePublishShare: () => ({ publishAndShare: vi.fn(), modal: null }),
}));
vi.mock('@client/app/hooks/useMessageEditMode', () => {
  const state = { triggerEdit: vi.fn(), editingMessageId: undefined, editTarget: undefined, clearEdit: vi.fn() };
  return { useMessageEditMode: (selector: (s: typeof state) => unknown) => selector(state) };
});
vi.mock('@client/app/components/Session/PromptMetaInspector', () => {
  const state = { setPromptMeta: vi.fn() };
  return { usePromptMetaInspector: (selector: (s: typeof state) => unknown) => selector(state) };
});
vi.mock('@client/app/hooks/useSubscribeChatCompletion', () => ({ useSubscribeChatCompletion: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useSearch: () => ({}) }));
vi.mock('@client/app/utils/fabFileUtils', () => ({ saveToFileAndWorkbench: vi.fn() }));
vi.mock('@client/app/utils/publishApi', () => ({ replyPublisher: vi.fn(() => vi.fn()) }));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: (selector: (s: { selectedAccount: null }) => unknown) => selector({ selectedAccount: null }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: () => false }),
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
vi.mock('./FallbackModelBadge', () => ({ default: () => null }));

import ChatHistory from './ChatHistory';
import { buildChatHistory } from './buildChatHistory';

const appTheme = extendTheme({ ...getThemeConfig() });
const queryClient = new QueryClient();
const noop = vi.fn();
const sendMessage = async () => {};
const virtuosoRef = { current: null };
const older = { id: 'quest-0', prompt: 'earlier', replies: ['Earlier answer.'], status: 'done' } as unknown as IChatHistoryItem;

const History = ({ quest, streaming }: { quest: IChatHistoryItem; streaming: boolean }) => {
  const flattenQuests = streaming ? [{ ...quest, replies: [] }, older] : [quest, older];
  const items = buildChatHistory(flattenQuests, {
    search: '',
    showPinnedOnly: false,
    activeStreamingQuestId: streaming ? quest.id! : null,
    streamingMessageData: streaming ? quest : null,
  });
  return (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <ChatHistory
          filteredChatHistory={items}
          sessionId="session-1"
          mode="chat"
          activeStreamingQuestId={streaming ? quest.id! : null}
          chatCompletion={(streaming ? { completed: false, stopped: false, quest } : undefined) as never}
          onDelete={noop}
          onPinToggle={noop}
          onSendMessage={sendMessage}
          search=""
          model="gpt-4o"
          canUseAdminTools={false}
          virtuosoRef={virtuosoRef}
          firstItemIndex={0}
          onStartReached={noop}
          onAtBottomStateChange={noop}
          scrollbarWidth={0}
        />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const quest = (reply: string, status: string) =>
  ({ id: 'quest-1', sessionId: 'session-1', prompt: 'chart please', replies: [reply], status }) as unknown as IChatHistoryItem;

describe('ChatHistory hands a streamed reply to its completed row without remounting its blocks', () => {
  it('keeps an image approved mid-stream loaded once the quest is done and leaves the streaming slot', () => {
    const reply = 'Here is the chart.\n\n![chart](https://example.com/c.png)\n\nIt shows growth.';
    const { rerender } = render(<History quest={quest(reply, 'running')} streaming />);
    fireEvent.click(screen.getByTestId('reply-image-load-btn'));
    expect(screen.getByTestId('reply-image-loaded')).toBeTruthy();
    rerender(<History quest={quest(reply, 'done')} streaming={false} />);
    expect(screen.queryByTestId('reply-image-load-btn')).toBeNull();
    expect(screen.getByTestId('reply-image-loaded')).toBeTruthy();
  });

  it('keeps it loaded when the reply also holds a regex with a negated class', () => {
    const reply = 'Strip with `/[^a-z]/g`.\n\n![chart](https://example.com/c.png)\n\nIt shows growth.';
    const { rerender } = render(<History quest={quest(reply, 'running')} streaming />);
    fireEvent.click(screen.getByTestId('reply-image-load-btn'));
    rerender(<History quest={quest(reply, 'done')} streaming={false} />);
    expect(screen.queryByTestId('reply-image-load-btn')).toBeNull();
  });
});

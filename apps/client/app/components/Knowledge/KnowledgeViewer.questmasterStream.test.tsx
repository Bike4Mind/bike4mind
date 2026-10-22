// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IMessageDataToClient } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const SESSION_ID = 'session-A';
const PLAN_ID = 'plan-1';
const appTheme = extendTheme({ ...getThemeConfig() });

const h = vi.hoisted(() => ({
  handlers: new Map<string, (msg: unknown) => unknown>(),
  questMasterPlanIds: [] as unknown[],
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: { id: SESSION_ID }, currentSessionId: SESSION_ID }),
  useWorkBenchFiles: () => [],
  useSystemPromptFiles: () => ({ systemFiles: [] }),
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/hooks/useMessageFiles', () => ({ useMessageFiles: () => [] }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({
    subscribeToAction: (action: string, handler: (msg: unknown) => unknown) => {
      h.handlers.set(action, handler);
      return () => h.handlers.delete(action);
    },
  }),
}));
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (s: { model: string }) => unknown) => selector({ model: 'test-model' }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: { currentUser: { id: string; organizationId: string } }) => unknown) =>
    selector({ currentUser: { id: 'user-1', organizationId: 'org-1' } }),
}));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({ useSelectedAccount: () => null }));
vi.mock('@client/app/hooks/usePublishShare', () => ({
  usePublishShare: () => ({ publishAndShare: vi.fn(), modal: null }),
}));
vi.mock('@client/app/hooks/useAdminTools', () => ({ useAdminTools: () => ({ canUseAdminTools: false }) }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/hooks/data/useQuestExport', () => ({
  useQuestExport: () => ({ startExport: vi.fn(), isExporting: false, isStarting: false, progress: 0 }),
}));
vi.mock('@client/app/hooks/data/artifacts', () => ({ useArtifact: () => ({ data: undefined }) }));
vi.mock('@client/app/hooks/useArtifactPersistence', () => ({ useArtifactPersistence: () => ({ isPersisted: false }) }));
vi.mock('@client/app/utils/fabFileUtils', () => ({ getContentFromFabfile: vi.fn().mockResolvedValue('') }));
vi.mock('@client/app/utils/filesAPICalls', () => ({ getFabFileByIdFromServer: vi.fn() }));

vi.mock('../GenAI/QuestMasterReply', () => ({
  default: ({ questMasterPlanId }: { questMasterPlanId: unknown }) => {
    h.questMasterPlanIds.push(questMasterPlanId);
    return null;
  },
}));

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('react-syntax-highlighter', () => ({ Prism: () => null }));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({ oneDark: {} }));
vi.mock('@client/app/components/ProfileModal/ContentPreviewModal', () => ({ default: () => null }));
vi.mock('./EditFileDialog', () => ({ default: () => null }));
vi.mock('./DiffPreview', () => ({ default: () => null }));
vi.mock('./TextViewer', () => ({ default: () => null }));
vi.mock('./MarkdownViewer', () => ({ default: () => null, UnmarkedCitedPassage: () => null }));
vi.mock('./DOCXViewer', () => ({ default: () => null }));
vi.mock('./CSVViewer', () => ({ default: () => null }));
vi.mock('./JSONViewer', () => ({ default: () => null }));
vi.mock('./XLSXViewer', () => ({ default: () => null }));
vi.mock('../Charts/MermaidChart', () => ({ default: () => null }));
vi.mock('../Charts/RechartsRenderer', () => ({ default: () => null }));
vi.mock('../Chess/ChessBoard', () => ({ default: () => null }));
vi.mock('../Chess/InteractiveChessBoard', () => ({ default: () => null }));
vi.mock('../common/DownloadMenu', () => ({ default: () => null, downloadFile: vi.fn(), copyToClipboard: vi.fn() }));

import KnowledgeViewer, { setKnowledgeViewer } from './KnowledgeViewer';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';

const renderViewer = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <CssVarsProvider theme={appTheme}>
      <QueryClientProvider client={client}>
        <KnowledgeViewer />
      </QueryClientProvider>
    </CssVarsProvider>
  );
  await act(async () => {});
};

const streamSubQuestReply = async () => {
  const handler = h.handlers.get('streamed_chat_completion');
  expect(handler).toBeDefined();
  await act(async () => {
    await handler?.({
      action: 'streamed_chat_completion',
      quest: { id: 'sub-quest-1', sessionId: SESSION_ID, reply: 'Working on step one', questMasterReply: 'Step one' },
    } as unknown as IMessageDataToClient);
  });
};

describe('KnowledgeViewer questmaster item during a streamed reply', () => {
  beforeEach(() => {
    h.handlers.clear();
    h.questMasterPlanIds.length = 0;
    setKnowledgeViewer({ selectedTabIndex: 0, showLineNumbers: false });
    useSessionLayout.setState({
      layout: 'vertical',
      recentArtifacts: [],
      artifactData: undefined,
      selectedArtifactId: undefined,
      previewFile: null,
    });
    // Same shape QuestMasterPreviewCard opens the viewer with.
    setSessionLayout({
      layout: 'vertical',
      artifactData: { type: 'questmaster', content: PLAN_ID, mimeType: 'application/x-questmaster', id: PLAN_ID },
      selectedArtifactId: PLAN_ID,
    });
  });

  afterEach(() => cleanup());

  it('keeps the plan id as the item content', async () => {
    await renderViewer();
    await streamSubQuestReply();

    const { artifactData, recentArtifacts } = useSessionLayout.getState();
    expect(artifactData?.content).toBe(PLAN_ID);
    expect(recentArtifacts.find(a => a.id === PLAN_ID)?.content).toBe(PLAN_ID);
  });

  it('keeps passing the plan id string to QuestMasterReply', async () => {
    await renderViewer();
    expect(h.questMasterPlanIds).toContain(PLAN_ID);

    await streamSubQuestReply();

    expect(h.questMasterPlanIds.every(id => id === PLAN_ID)).toBe(true);
  });
});

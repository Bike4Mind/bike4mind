// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { QuestMasterData } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  startExport: vi.fn(),
}));

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: { id: 'session-A' }, currentSessionId: 'session-A' }),
  useWorkBenchFiles: () => [],
  useSystemPromptFiles: () => ({ systemFiles: [] }),
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));

vi.mock('@client/app/hooks/useMessageFiles', () => ({ useMessageFiles: () => [] }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction: () => () => {} }),
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
  useQuestExport: () => ({ startExport: h.startExport, isExporting: false, isStarting: false, progress: 0 }),
}));
vi.mock('@client/app/hooks/data/artifacts', () => ({ useArtifact: () => ({ data: undefined }) }));
vi.mock('@client/app/hooks/useArtifactPersistence', () => ({ useArtifactPersistence: () => ({ isPersisted: false }) }));
vi.mock('@client/app/utils/fabFileUtils', () => ({ getContentFromFabfile: vi.fn().mockResolvedValue('') }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));

// Shallow: none of these are under test, and several drag in their own provider chains.
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('react-syntax-highlighter', () => ({ Prism: () => null }));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({ oneDark: {} }));
vi.mock('@client/app/components/ProfileModal/ContentPreviewModal', () => ({ default: () => null }));
vi.mock('../EditFileDialog', () => ({ default: () => null }));
vi.mock('../DiffPreview', () => ({ default: () => null }));
vi.mock('../TextViewer', () => ({ default: () => <div data-testid="text-viewer" /> }));
vi.mock('../MarkdownViewer', () => ({ default: () => null }));
vi.mock('../DOCXViewer', () => ({ default: () => null }));
vi.mock('../CSVViewer', () => ({ default: () => null }));
vi.mock('../JSONViewer', () => ({ default: () => null }));
vi.mock('../XLSXViewer', () => ({ default: () => null }));
vi.mock('../../GenAI/QuestMasterReply', () => ({ default: () => null }));
vi.mock('../../Charts/MermaidChart', () => ({ default: () => null }));
vi.mock('../../Charts/RechartsRenderer', () => ({ default: () => null }));
vi.mock('../../Chess/ChessBoard', () => ({ default: () => null }));
vi.mock('../../Chess/InteractiveChessBoard', () => ({ default: () => null }));
vi.mock('../../common/DownloadMenu', () => ({ default: () => null, downloadFile: vi.fn(), copyToClipboard: vi.fn() }));

import KnowledgeViewer, { setKnowledgeViewer } from '../KnowledgeViewer';
import useSessionLayout from '@client/app/hooks/useSessionLayout';

const PLAN_ID = '507f1f77bcf86cd799439011';

// What the streamed_chat_completion subscription writes back over the artifact's content once a
// quest streams in the same session: the plan id is gone, only the item's `id` still carries it.
const streamedQuestContent: QuestMasterData = {
  id: 'quest-1',
  title: 'My Quest Plan',
  description: 'streamed reply',
  complexity: 'medium',
  subQuests: [],
};

describe('KnowledgeViewer quest export', () => {
  beforeEach(() => {
    h.startExport.mockClear();
    setKnowledgeViewer({ selectedTabIndex: 0, showLineNumbers: false });
    useSessionLayout.setState({
      layout: 'vertical',
      recentArtifacts: [
        { type: 'questmaster', id: PLAN_ID, content: streamedQuestContent, mimeType: 'application/json' },
      ],
      artifactData: undefined,
      selectedArtifactId: undefined,
      previewFile: null,
    });
  });

  afterEach(() => cleanup());

  it('exports with the plan id even after the artifact content has been overwritten', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <KnowledgeViewer />
      </QueryClientProvider>
    );
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledgeviewer-download-btn'));
    });

    expect(h.startExport).toHaveBeenCalledWith(PLAN_ID);
  });
});

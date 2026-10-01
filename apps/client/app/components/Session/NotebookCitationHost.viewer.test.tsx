// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { CitableSource } from '@bike4mind/common';

// Same shallow harness as KnowledgeViewer.autoHide.test.tsx: the real viewer and the real store,
// with everything that drags in its own provider chain stubbed.
const h = vi.hoisted(() => ({ fetchedFile: null as Record<string, unknown> | null }));

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@client/app/utils/filesAPICalls', async importOriginal => {
  const actual = await importOriginal<typeof import('@client/app/utils/filesAPICalls')>();
  return { ...actual, getFabFileByIdFromServer: vi.fn(() => Promise.resolve(h.fetchedFile)) };
});

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
vi.mock('@client/app/hooks/data/useQuestExport', () => ({ useQuestExport: () => ({ exportQuest: vi.fn() }) }));
vi.mock('@client/app/hooks/data/artifacts', () => ({ useArtifact: () => ({ data: undefined }) }));
vi.mock('@client/app/hooks/useArtifactPersistence', () => ({ useArtifactPersistence: () => ({ isPersisted: false }) }));
vi.mock('@client/app/utils/fabFileUtils', () => ({ getContentFromFabfile: vi.fn().mockResolvedValue('') }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('react-syntax-highlighter', () => ({ Prism: () => null }));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({ oneDark: {} }));
vi.mock('@client/app/components/ProfileModal/ContentPreviewModal', () => ({ default: () => null }));
vi.mock('@client/app/components/Knowledge/EditFileDialog', () => ({ default: () => null }));
vi.mock('@client/app/components/Knowledge/DiffPreview', () => ({ default: () => null }));
vi.mock('@client/app/components/Knowledge/TextViewer', () => ({
  default: () => <div data-testid="text-viewer" />,
}));
vi.mock('@client/app/components/Knowledge/MarkdownViewer', () => ({
  default: () => null,
  UnmarkedCitedPassage: () => null,
}));
vi.mock('@client/app/components/Knowledge/DOCXViewer', () => ({ default: () => null }));
vi.mock('@client/app/components/Knowledge/CSVViewer', () => ({ default: () => null }));
vi.mock('@client/app/components/Knowledge/JSONViewer', () => ({ default: () => null }));
vi.mock('@client/app/components/Knowledge/XLSXViewer', () => ({ default: () => null }));
vi.mock('@client/app/components/GenAI/QuestMasterReply', () => ({ default: () => null }));
vi.mock('@client/app/components/Charts/MermaidChart', () => ({ default: () => null }));
vi.mock('@client/app/components/Charts/RechartsRenderer', () => ({ default: () => null }));
vi.mock('@client/app/components/Chess/ChessBoard', () => ({ default: () => null }));
vi.mock('@client/app/components/Chess/InteractiveChessBoard', () => ({ default: () => null }));
vi.mock('@client/app/components/common/DownloadMenu', () => ({
  default: () => null,
  downloadFile: vi.fn(),
  copyToClipboard: vi.fn(),
}));

import KnowledgeViewer, { setKnowledgeViewer } from '@client/app/components/Knowledge/KnowledgeViewer';
import useSessionLayout from '@client/app/hooks/useSessionLayout';
import { getThemeConfig } from '../../utils/themes';
import CitableSources from './CitableSources';
import NotebookCitationHost from './NotebookCitationHost';

const appTheme = extendTheme({ ...getThemeConfig() });

const chip: CitableSource = {
  id: 'file-1',
  type: 'document',
  title: 'Leave policy.txt',
  url: '/opti?mode=datalake&article=file-1',
  status: 'complete',
  metadata: { sourceSystem: 'knowledge_base' },
};

/**
 * The host test pins the store write; this pins that the write is what actually puts the file on
 * screen. A change to the viewer's preview-tab wiring (or to the layout the host picks) would leave
 * the store assertions green while the chip click opened nothing.
 */
describe('NotebookCitationHost -> KnowledgeViewer wiring', () => {
  beforeEach(() => {
    navigate.mockClear();
    h.fetchedFile = {
      id: 'file-1',
      fileName: 'Leave policy.txt',
      mimeType: 'text/plain',
      fileUrl: 'https://files.example.test/file-1.txt',
      fileSize: 12,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    setKnowledgeViewer({ selectedTabIndex: 0, showLineNumbers: false });
    useSessionLayout.setState({
      layout: 'vertical',
      recentArtifacts: [],
      artifactData: undefined,
      selectedArtifactId: undefined,
      previewFile: null,
      citedPassage: null,
    });
  });

  afterEach(() => cleanup());

  it('shows the clicked chip file in the viewer while the chip list stays on screen', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CssVarsProvider theme={appTheme}>
          <NotebookCitationHost sessionId="session-A">
            <KnowledgeViewer />
            <CitableSources citables={[chip]} />
          </NotebookCitationHost>
        </CssVarsProvider>
      </QueryClientProvider>
    );
    expect(screen.getByTestId('knowledge-viewer-empty-state')).toBeTruthy();

    fireEvent.click(screen.getByTestId('citable-source-chip'));

    await waitFor(() => expect(screen.queryByTestId('knowledge-viewer-empty-state')).toBeNull());
    expect(screen.getAllByText('Leave policy.txt').length).toBeGreaterThan(1);
    expect(screen.getByTestId('citable-source-chip')).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});

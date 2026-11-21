// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HtmlArtifact } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  downloadFile: vi.fn(),
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
  useQuestExport: () => ({ startExport: vi.fn(), isExporting: false, isStarting: false, progress: 0 }),
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
vi.mock('../../common/DownloadMenu', () => ({
  default: () => null,
  downloadFile: h.downloadFile,
  copyToClipboard: vi.fn(),
}));
vi.mock('../HtmlArtifactViewer', () => ({ default: () => null }));

import KnowledgeViewer, { setKnowledgeViewer } from '../KnowledgeViewer';
import useSessionLayout from '@client/app/hooks/useSessionLayout';

const CHART_SRC = '/static/lib/chart.js@4.x.js';

const htmlArtifact: HtmlArtifact = {
  id: 'html-1',
  type: 'html',
  title: 'Sales Chart',
  content: `<html><body><canvas id="c"></canvas><script src="${CHART_SRC}"></script></body></html>`,
  metadata: { allowedScripts: [], sanitized: true },
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const renderViewer = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KnowledgeViewer />
    </QueryClientProvider>
  );
  await act(async () => {});
};

describe('KnowledgeViewer html artifact download', () => {
  beforeEach(() => {
    h.downloadFile.mockClear();
    setKnowledgeViewer({ selectedTabIndex: 0, showLineNumbers: false });
    useSessionLayout.setState({
      layout: 'vertical',
      recentArtifacts: [{ type: 'html', id: 'html-1', content: htmlArtifact, mimeType: 'text/html' }],
      artifactData: undefined,
      selectedArtifactId: undefined,
      previewFile: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('downloads the page with the blessed library inlined instead of a root-relative src', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, status: 200, text: async () => 'window.Chart = {};' }) as Response
    );
    vi.stubGlobal('fetch', fetchMock);
    await renderViewer();

    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledgeviewer-download-btn'));
    });

    expect(h.downloadFile).toHaveBeenCalledTimes(1);
    const [content, fileName, mimeType] = h.downloadFile.mock.calls[0];
    expect(fileName).toBe('Sales Chart.html');
    expect(mimeType).toBe('text/html');
    expect(content).not.toContain('src="/static/lib/');
    expect(content).toContain('<script>window.Chart = {};</script>');
  });

  it('downloads an absolute app-origin src when the library cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    await renderViewer();

    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledgeviewer-download-btn'));
    });

    const [content] = h.downloadFile.mock.calls[0];
    expect(content).not.toContain('src="/static/lib/');
    expect(content).toContain(`src="${window.location.origin}${CHART_SRC}"`);
  });
});

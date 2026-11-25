// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
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
vi.mock('@client/app/hooks/data/artifacts', () => ({ useArtifact: () => ({ data: undefined }) }));
vi.mock('@client/app/hooks/useArtifactPersistence', () => ({ useArtifactPersistence: () => ({ isPersisted: false }) }));
vi.mock('@client/app/utils/fabFileUtils', () => ({ getContentFromFabfile: vi.fn().mockResolvedValue('') }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get, post: h.post, put: vi.fn() } }));

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
vi.mock('../../Charts/MermaidChart', () => ({ default: () => null }));
vi.mock('../../Charts/RechartsRenderer', () => ({ default: () => null }));
vi.mock('../../Chess/ChessBoard', () => ({ default: () => null }));
vi.mock('../../Chess/InteractiveChessBoard', () => ({ default: () => null }));
vi.mock('../../common/DownloadMenu', () => ({ default: () => null, downloadFile: vi.fn(), copyToClipboard: vi.fn() }));

import KnowledgeViewer, { setKnowledgeViewer } from '../KnowledgeViewer';
import useSessionLayout from '@client/app/hooks/useSessionLayout';

const PLAN_ID = '507f1f77bcf86cd799439011';

const renderViewer = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KnowledgeViewer />
    </QueryClientProvider>
  );
  await act(async () => {});
};

describe('KnowledgeViewer legacy QuestMaster plan tab', () => {
  beforeEach(() => {
    h.get.mockReset();
    h.post.mockReset();
    setKnowledgeViewer({ selectedTabIndex: 0, showLineNumbers: false });
  });

  afterEach(() => cleanup());

  it.each([
    ['a plan id', PLAN_ID],
    ['a streamed plan object', { id: 'quest-1', title: 'My Quest Plan', subQuests: [] }],
  ])('shows the legacy note without fetching when the item content is %s', async (_label, content) => {
    useSessionLayout.setState({
      layout: 'vertical',
      recentArtifacts: [{ type: 'questmaster', id: PLAN_ID, content, mimeType: 'application/x-questmaster' }],
      artifactData: undefined,
      selectedArtifactId: undefined,
      previewFile: null,
    } as never);

    await renderViewer();

    expect(screen.getByTestId('legacy-questmaster-note').textContent).toBe(
      'This reply had a QuestMaster plan. QuestMaster plans are no longer shown in chat. ' +
        'Saved plans were copied as markdown files to the "Questmaster archive" folder in your files.'
    );
    // The tab selector shows the legacy item under its fixed label.
    expect(screen.getByRole('combobox').textContent).toBe('Quest Plan');

    // Joy's Tooltip exposes a string title as the child's aria-label, so the label is the tooltip text.
    // The copy button has no test id; its tooltip wrapper is the only stable handle on it.
    const copyWrapper = screen.getByLabelText('Nothing to copy');
    expect(copyWrapper.querySelector('button')).toBeDisabled();
    const downloadBtn = screen.getByTestId('knowledgeviewer-download-btn');
    expect(downloadBtn).toBeDisabled();
    expect(downloadBtn.getAttribute('aria-label')).toBe('Nothing to download');
    expect(screen.queryByTestId('artifact-viewer-share')).toBeNull();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });
});

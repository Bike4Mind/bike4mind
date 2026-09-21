// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mutable harness state, read by the hoisted module mocks below.
const h = vi.hoisted(() => ({
  currentSessionId: 'session-A' as string | null,
  messageFiles: [] as Array<Record<string, unknown>>,
  systemFiles: [] as Array<Record<string, unknown>>,
  setSessionLayoutCalls: [] as Array<Record<string, unknown>>,
}));

// Keep the real store (the assertions read its `layout`), but record every write. The effect
// under test reaches the layout only through setSessionLayout, so those calls are the signal.
vi.mock('@client/app/hooks/useSessionLayout', async importOriginal => {
  const actual = await importOriginal<typeof import('@client/app/hooks/useSessionLayout')>();
  return {
    ...actual,
    setSessionLayout: (arg: Record<string, unknown>) => {
      h.setSessionLayoutCalls.push(arg);
      return actual.setSessionLayout(arg as never);
    },
  };
});

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: { id: h.currentSessionId }, currentSessionId: h.currentSessionId }),
  useWorkBenchFiles: () => [],
  useSystemPromptFiles: () => ({ systemFiles: h.systemFiles }),
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));

vi.mock('@client/app/hooks/useMessageFiles', () => ({
  useMessageFiles: () => h.messageFiles,
}));

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
vi.mock('../GenAI/QuestMasterReply', () => ({ default: () => null }));
vi.mock('../Charts/MermaidChart', () => ({ default: () => null }));
vi.mock('../Charts/RechartsRenderer', () => ({ default: () => null }));
vi.mock('../Chess/ChessBoard', () => ({ default: () => null }));
vi.mock('../Chess/InteractiveChessBoard', () => ({ default: () => null }));
vi.mock('../common/DownloadMenu', () => ({ default: () => null, downloadFile: vi.fn(), copyToClipboard: vi.fn() }));

import KnowledgeViewer, { setKnowledgeViewer } from '../KnowledgeViewer';
import useSessionLayout from '@client/app/hooks/useSessionLayout';

const EMPTY_STATE_TESTID = 'knowledge-viewer-empty-state';

const textFile = (id: string) => ({
  id,
  fileName: `${id}.txt`,
  mimeType: 'text/plain',
  fileUrl: `https://files.example.test/${id}.txt`,
  fileSize: 12,
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('KnowledgeViewer auto-hide wiring', () => {
  beforeEach(() => {
    h.currentSessionId = 'session-A';
    h.messageFiles = [];
    h.systemFiles = [];
    h.setSessionLayoutCalls = [];
    setKnowledgeViewer({ selectedTabIndex: 0, showLineNumbers: false });
    useSessionLayout.setState({
      layout: 'vertical',
      recentArtifacts: [],
      artifactData: undefined,
      selectedArtifactId: undefined,
      previewFile: null,
    });
  });

  afterEach(() => cleanup());

  it('keeps an empty pane open on mount, and renders the empty state', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <KnowledgeViewer />
      </QueryClientProvider>
    );

    expect(screen.getByTestId(EMPTY_STATE_TESTID)).toBeTruthy();
    await act(async () => {});

    expect(useSessionLayout.getState().layout).toBe('vertical');
    expect(h.setSessionLayoutCalls.some(call => call.layout === 'hide')).toBe(false);
  });

  it('gives the empty-state close button an accessible name and closes the pane when clicked', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <KnowledgeViewer />
      </QueryClientProvider>
    );

    const close = screen.getByTestId('knowledge-viewer-empty-close');
    expect(close.getAttribute('aria-label')).toBe('Close Knowledge Preview');

    await act(async () => {
      fireEvent.click(close);
    });

    expect(h.setSessionLayoutCalls.some(call => call.layout === 'hide')).toBe(true);
    expect(useSessionLayout.getState().layout).toBe('hide');
  });

  it('keeps the pane open on a session-less page', async () => {
    // Pins the intentionally changed /new?article=... behavior: the context session id is null
    // until hydration, so a page with no session must not be read as "no content, collapse".
    h.currentSessionId = null;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <KnowledgeViewer />
      </QueryClientProvider>
    );

    expect(screen.getByTestId(EMPTY_STATE_TESTID)).toBeTruthy();
    await act(async () => {});

    expect(useSessionLayout.getState().layout).toBe('vertical');
    expect(h.setSessionLayoutCalls.some(call => call.layout === 'hide')).toBe(false);
  });

  it('still auto-collapses a cached session emptied after switching back to it', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A fresh element per render: React bails out when handed the identical element reference.
    const ui = () => (
      <QueryClientProvider client={client}>
        <KnowledgeViewer />
      </QueryClientProvider>
    );
    const { rerender } = render(ui());

    // Land on a session whose file list is already available the moment the id flips - the
    // warm-cache case, where knowledgeItems is non-empty on the session-change render itself.
    h.currentSessionId = 'session-B';
    h.messageFiles = [textFile('file-b')];
    await act(async () => {
      rerender(ui());
    });
    expect(screen.queryByTestId(EMPTY_STATE_TESTID)).toBeNull();

    // Delete that session's last item. The latch armed on the change render, so the pane collapses.
    h.messageFiles = [];
    await act(async () => {
      rerender(ui());
    });

    expect(screen.getByTestId(EMPTY_STATE_TESTID)).toBeTruthy();
    expect(h.setSessionLayoutCalls.some(call => call.layout === 'hide')).toBe(true);
  });

  it('still auto-collapses after a session switch when the last system file is removed', async () => {
    // System prompt files are user/global-scoped, not session-transient: they describe the
    // current render, so they must arm the latch even on the session-change render. Excluding
    // them left the latch disarmed across the switch, and removing that final file left an empty
    // pane open. recentArtifacts/previewFile stay empty here so no other effect re-arms it.
    h.systemFiles = [textFile('system-1')];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = () => (
      <QueryClientProvider client={client}>
        <KnowledgeViewer />
      </QueryClientProvider>
    );
    const { rerender } = render(ui());
    expect(screen.queryByTestId(EMPTY_STATE_TESTID)).toBeNull();

    // Switch sessions while the system file is visible: the latch resets, then must re-arm from it.
    h.currentSessionId = 'session-B';
    await act(async () => {
      rerender(ui());
    });
    expect(screen.queryByTestId(EMPTY_STATE_TESTID)).toBeNull();

    // Disable/delete that final file - the pane empties and must collapse.
    h.systemFiles = [];
    await act(async () => {
      rerender(ui());
    });

    expect(screen.getByTestId(EMPTY_STATE_TESTID)).toBeTruthy();
    expect(h.setSessionLayoutCalls.some(call => call.layout === 'hide')).toBe(true);
  });
});

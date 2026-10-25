// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactArtifact } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ReactArtifactGroupRole } from '@client/app/utils/reactArtifactGroup';

const SESSION_ID = 'session-A';
const ENTRY_ID = 'artifact_react_app_1700000000000_0';
const appTheme = extendTheme({ ...getThemeConfig() });

interface LatestArtifact {
  artifact: { id: string; version: number; title: string; metadata: unknown; updatedAt: Date };
  content: { content: string };
}

const h = vi.hoisted(() => ({
  // Props of every next/dynamic viewer KnowledgeViewer renders, in render order.
  viewerProps: [] as Record<string, unknown>[],
  latest: undefined as LatestArtifact | undefined,
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: h.api }));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: { id: SESSION_ID }, currentSessionId: SESSION_ID }),
  useWorkBenchFiles: () => [],
  useSystemPromptFiles: () => ({ systemFiles: [] }),
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/hooks/useMessageFiles', () => ({ useMessageFiles: () => [] }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction: () => () => undefined }),
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
vi.mock('@client/app/hooks/data/artifacts', () => ({ useArtifact: () => ({ data: h.latest }) }));
vi.mock('@client/app/hooks/useArtifactPersistence', () => ({ useArtifactPersistence: () => ({ isPersisted: true }) }));
vi.mock('@client/app/utils/fabFileUtils', () => ({ getContentFromFabfile: vi.fn().mockResolvedValue('') }));
vi.mock('@client/app/utils/filesAPICalls', () => ({ getFabFileByIdFromServer: vi.fn() }));
vi.mock('../GenAI/QuestMasterReply', () => ({ default: () => null }));

vi.mock('next/dynamic', () => ({
  default: () => (props: Record<string, unknown>) => {
    h.viewerProps.push(props);
    return null;
  },
}));
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

const ENTRY_CODE = "import Panel from './Panel';\nexport default function App() { return <Panel />; }";
const ENTRY_GROUP: ReactArtifactGroupRole = {
  role: 'entry',
  files: { Panel: 'export default function Panel() { return null; }' },
  dependencies: ['react'],
  siblings: [{ identifier: 'Panel', title: 'Panel' }],
};

const entry: ReactArtifact = {
  id: ENTRY_ID,
  type: 'react',
  title: 'Panel App',
  content: ENTRY_CODE,
  metadata: { dependencies: ['react'], hasDefaultExport: true, errorBoundary: true },
  createdAt: new Date(1700000000000),
  updatedAt: new Date(1700000000000),
} as ReactArtifact;

const latestVersion = (version: number, content: string): LatestArtifact => ({
  artifact: { id: ENTRY_ID, version, title: entry.title, metadata: entry.metadata, updatedAt: new Date() },
  content: { content },
});

const SIBLING_ID = 'artifact_react_panel_1700000000000_1';
const SIBLING_CODE = ENTRY_GROUP.files.Panel;
const sibling: ReactArtifact = { ...entry, id: SIBLING_ID, title: 'Panel', content: SIBLING_CODE } as ReactArtifact;
const EDITED_CODE = ENTRY_CODE.replace('<Panel />', '<section><Panel /></section>');

const reactViewerProps = () => h.viewerProps.filter(p => (p.artifact as ReactArtifact | undefined)?.id === ENTRY_ID);

/** Saves through the entry viewer's onSave, as its Save button does, with the PUT answering v2. */
async function saveEntry(code: string) {
  h.api.put.mockResolvedValueOnce({ data: { artifact: { id: ENTRY_ID, version: 2 } } });
  const onSave = reactViewerProps().at(-1)?.onSave as (content: string) => Promise<unknown>;
  await act(async () => {
    await onSave(code);
  });
}

const viewerTree = () => (
  <CssVarsProvider theme={appTheme}>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <KnowledgeViewer />
    </QueryClientProvider>
  </CssVarsProvider>
);

describe('KnowledgeViewer with a multi-file React entry', () => {
  beforeEach(() => {
    h.viewerProps.length = 0;
    h.api.put.mockReset();
    h.api.get.mockReset();
    h.api.post.mockReset();
    h.latest = latestVersion(1, ENTRY_CODE);
    setKnowledgeViewer({ selectedTabIndex: 0, showLineNumbers: false });
    useSessionLayout.setState({
      layout: 'vertical',
      recentArtifacts: [],
      artifactData: undefined,
      selectedArtifactId: undefined,
      previewFile: null,
    });
    // Same shape ArtifactPreviewCard opens the viewer with for an entry card.
    setSessionLayout({
      layout: 'vertical',
      artifactData: {
        type: 'react',
        content: entry,
        mimeType: 'application/vnd.ant.react',
        id: ENTRY_ID,
        reactGroup: ENTRY_GROUP,
      },
      selectedArtifactId: ENTRY_ID,
    });
  });

  afterEach(() => cleanup());

  it('hands the group to ReactArtifactViewer with the entry', async () => {
    render(viewerTree());
    await act(async () => {});

    const props = reactViewerProps().at(-1);
    expect(props?.group).toBe(ENTRY_GROUP);
    expect((props?.artifact as ReactArtifact).content).toBe(ENTRY_CODE);
  });

  it('keeps the group when a newer persisted version of the entry is adopted', async () => {
    const view = render(viewerTree());
    await act(async () => {});

    const newer = ENTRY_CODE.replace('<Panel />', '<main><Panel /></main>');
    h.latest = latestVersion(2, newer);
    view.rerender(viewerTree());
    await act(async () => {});

    expect(useSessionLayout.getState().artifactData).toMatchObject({ id: ENTRY_ID, reactGroup: ENTRY_GROUP });
    const props = reactViewerProps().at(-1);
    expect((props?.artifact as ReactArtifact).content).toBe(newer);
    expect(props?.group).toBe(ENTRY_GROUP);
  });

  it('saves the entry after a sent message cleared artifactData while its tab stayed open', async () => {
    render(viewerTree());
    await act(async () => {});
    // What useSendMessage does on send: the open artifact is cleared, its tab is not.
    act(() => setSessionLayout({ selectedArtifactId: undefined, artifactData: undefined }));

    await saveEntry(EDITED_CODE);

    const state = useSessionLayout.getState();
    expect(state.recentArtifacts.map(a => a.id)).toEqual([ENTRY_ID]);
    expect(state.artifactData).toMatchObject({
      id: ENTRY_ID,
      reactGroup: ENTRY_GROUP,
      content: { content: EDITED_CODE },
    });
    expect(state.selectedArtifactId).toBe(ENTRY_ID);
    const props = reactViewerProps().at(-1);
    expect((props?.artifact as ReactArtifact).content).toBe(EDITED_CODE);
    expect(props?.group).toBe(ENTRY_GROUP);
  });

  it('saves the entry into its own tab while its sibling is the open artifact', async () => {
    const siblingTab = {
      type: 'react' as const,
      content: sibling,
      mimeType: 'application/vnd.ant.react',
      id: SIBLING_ID,
      reactGroup: { role: 'sibling' as const, entryTitle: entry.title },
    };
    setSessionLayout({ layout: 'vertical', artifactData: siblingTab, selectedArtifactId: SIBLING_ID });
    // Picking the entry's tab in the viewer moves the selection, not artifactData.
    setSessionLayout({ selectedArtifactId: ENTRY_ID });
    render(viewerTree());
    await act(async () => {});

    await saveEntry(EDITED_CODE);

    const state = useSessionLayout.getState();
    expect(state.recentArtifacts.find(a => a.id === SIBLING_ID)).toBe(siblingTab);
    expect(state.recentArtifacts.find(a => a.id === ENTRY_ID)).toMatchObject({
      reactGroup: ENTRY_GROUP,
      content: { id: ENTRY_ID, content: EDITED_CODE },
    });
    expect(state.artifactData?.id).toBe(ENTRY_ID);
    expect(state.selectedArtifactId).toBe(ENTRY_ID);
  });

  it('records the saved version on the open tab, so a remounted viewer opens on it', async () => {
    render(viewerTree());
    await act(async () => {});

    await saveEntry(EDITED_CODE);

    const state = useSessionLayout.getState();
    expect(state.artifactData?.content).toMatchObject({ id: ENTRY_ID, version: 2, content: EDITED_CODE });
    expect(state.recentArtifacts.find(a => a.id === ENTRY_ID)?.content).toMatchObject({ version: 2 });
    expect((reactViewerProps().at(-1)?.artifact as ReactArtifact).version).toBe(2);
  });

  // A card can carry an id minted before its reply was saved, or one restored from a stale
  // layout. Creating a row under that id would leave a second copy beside the reply's own.
  it("lands a save on the session's row for the entry when the card's id names none", async () => {
    const SAVED_ID = 'artifact_react_app_1700000000000_1';
    render(viewerTree());
    await act(async () => {});
    h.api.put
      .mockRejectedValueOnce(Object.assign(new Error('Not found'), { response: { status: 404 } }))
      .mockResolvedValueOnce({ data: { artifact: { id: SAVED_ID, version: 2 } } });
    h.api.get.mockResolvedValue({ data: { artifacts: [{ id: SAVED_ID }] } });

    const onSave = reactViewerProps().at(-1)?.onSave as (content: string) => Promise<unknown>;
    await act(async () => {
      await onSave(EDITED_CODE);
    });

    expect(h.api.get).toHaveBeenCalledWith('/api/artifacts', {
      params: expect.objectContaining({ sessionId: SESSION_ID, type: 'react', identifier: 'app' }),
    });
    expect(h.api.put).toHaveBeenLastCalledWith(
      `/api/artifacts/${SAVED_ID}`,
      expect.objectContaining({ content: EDITED_CODE, createNewVersion: true })
    );
    expect(h.api.post).not.toHaveBeenCalled();
    expect(useSessionLayout.getState().artifactData).toMatchObject({
      id: SAVED_ID,
      reactGroup: ENTRY_GROUP,
      content: { id: SAVED_ID, version: 2, content: EDITED_CODE },
    });
  });
});

// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HtmlArtifact, IFabFileDocument } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  downloadData: vi.fn(),
}));

vi.mock('@client/app/utils/download', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/utils/download')>()),
  downloadData: h.downloadData,
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

  it('disables the download button and shows a spinner while the html download is being prepared', async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>(resolve => {
          release = resolve;
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    await renderViewer();
    const button = screen.getByTestId('knowledgeviewer-download-btn');
    expect(button).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(button);
    });

    expect(button).toBeDisabled();
    expect(within(button).getByRole('progressbar')).toBeInTheDocument();
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.downloadFile).not.toHaveBeenCalled();

    await act(async () => {
      release({ ok: true, status: 200, text: async () => 'window.Chart = {};' } as Response);
    });

    expect(button).not.toBeDisabled();
    expect(within(button).queryByRole('progressbar')).toBeNull();
    expect(h.downloadFile).toHaveBeenCalledTimes(1);
  });
});

describe('KnowledgeViewer stored file download', () => {
  const SAVED_HTML = `<html><body><script src="${CHART_SRC}"></script></body></html>`;

  const storedFile = (mimeType: string, fileName: string) =>
    ({
      id: 'file-1',
      fileName,
      mimeType,
      fileUrl: 'https://files.example.com/signed/file-1',
      createdAt: new Date(),
    }) as unknown as IFabFileDocument;

  // Routes the signed file URL and the library fetch to separate responses.
  const stubFileFetch = (body: BlobPart) => {
    const blob = new Blob([body]);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith(CHART_SRC)) {
        return { ok: true, status: 200, text: async () => 'window.Chart = {};' } as Response;
      }
      return { ok: true, status: 200, blob: async () => blob } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, blob };
  };

  const openFile = (file: IFabFileDocument) =>
    useSessionLayout.setState({
      layout: 'vertical',
      recentArtifacts: [],
      artifactData: undefined,
      selectedArtifactId: undefined,
      previewFile: file,
    });

  beforeEach(() => {
    h.downloadData.mockClear();
    h.downloadFile.mockClear();
    setKnowledgeViewer({ selectedTabIndex: 0, showLineNumbers: false });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('inlines blessed libraries into a stored text/html file and keeps its filename', async () => {
    const { fetchMock } = stubFileFetch(SAVED_HTML);
    openFile(storedFile('text/html', 'sales-chart.html'));
    await renderViewer();

    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledgeviewer-download-btn'));
    });

    expect(fetchMock).toHaveBeenCalledWith('https://files.example.com/signed/file-1');
    expect(h.downloadData).toHaveBeenCalledTimes(1);
    const [content, fileName, mimeType] = h.downloadData.mock.calls[0];
    expect(fileName).toBe('sales-chart.html');
    expect(mimeType).toBe('text/html');
    expect(content).not.toContain('src="/static/lib/');
    expect(content).toContain('<script>window.Chart = {};</script>');
  });

  it('downloads other stored files as the untouched blob', async () => {
    stubFileFetch(SAVED_HTML);
    openFile(storedFile('text/plain', 'notes.txt'));
    await renderViewer();

    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledgeviewer-download-btn'));
    });

    expect(h.downloadData).toHaveBeenCalledTimes(1);
    const [content, fileName, mimeType] = h.downloadData.mock.calls[0];
    expect(content).toBeInstanceOf(Blob);
    expect(fileName).toBe('notes.txt');
    expect(mimeType).toBe('text/plain');
  });

  it('downloads a non-UTF-8 text/html file byte-identical when there is nothing to inline', async () => {
    // "caf" + 0xE9 is windows-1252 for "cafe" with an acute accent; decoding it as UTF-8 and re-encoding would corrupt it.
    const bytes = new Uint8Array([...Buffer.from('<html><body><p>caf'), 0xe9, ...Buffer.from('</p></body></html>')]);
    const { blob } = stubFileFetch(bytes);
    openFile(storedFile('text/html', 'cafe.html'));
    await renderViewer();

    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledgeviewer-download-btn'));
    });

    expect(h.downloadData).toHaveBeenCalledTimes(1);
    const [content, fileName, mimeType] = h.downloadData.mock.calls[0];
    expect(content).toBe(blob);
    expect(Array.from(new Uint8Array(await (content as Blob).arrayBuffer()))).toEqual(Array.from(bytes));
    expect(fileName).toBe('cafe.html');
    expect(mimeType).toBe('text/html');
  });

  it('resets the busy state when fetching a stored html file fails', async () => {
    let fail: (reason: Error) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            fail = reject;
          })
      )
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    openFile(storedFile('text/html', 'sales-chart.html'));
    await renderViewer();
    const button = screen.getByTestId('knowledgeviewer-download-btn');

    await act(async () => {
      fireEvent.click(button);
    });
    expect(button).toBeDisabled();
    expect(within(button).getByRole('progressbar')).toBeInTheDocument();

    await act(async () => {
      fail(new Error('offline'));
    });

    expect(button).not.toBeDisabled();
    expect(within(button).queryByRole('progressbar')).toBeNull();
    expect(h.downloadData).not.toHaveBeenCalled();
  });
});

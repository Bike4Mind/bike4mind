// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { AxiosError, AxiosHeaders } from 'axios';
import { serverStorageLimitMessage } from '@client/app/utils/storageQuota';
import { getThemeConfig } from '@client/app/utils/themes';

const FILE_ID = 'file-1';
const appTheme = extendTheme({ ...getThemeConfig() });

const h = vi.hoisted(() => ({
  post: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  submitError: { current: undefined as unknown },
}));

vi.mock('sonner', () => ({ toast: { error: h.toastError, success: h.toastSuccess } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: h.post, put: vi.fn() } }));

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: { id: 'session-A' }, currentSessionId: 'session-A' }),
  useWorkBenchFiles: () => [
    { id: 'file-1', fileName: 'notes.txt', mimeType: 'text/plain', fileSize: 10, fileUrl: 'https://f.test/n' },
  ],
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
vi.mock('@client/app/utils/filesAPICalls', () => ({
  getFabFileByIdFromServer: vi.fn().mockResolvedValue({ id: 'file-1', fileUrl: 'https://f.test/n' }),
}));

// The stubs drive the handlers directly; the submit stub records the re-thrown error.
vi.mock('./EditFileDialog', () => ({
  default: ({ onSubmit }: { onSubmit: (instruction: string, options: { returnDiff: boolean }) => Promise<void> }) => (
    <button
      data-testid="edit-dialog-submit-btn"
      onClick={() => onSubmit('fix it', { returnDiff: true }).catch(err => (h.submitError.current = err))}
    />
  ),
}));
vi.mock('./DiffPreview', () => ({
  default: ({ onApply }: { onApply: () => void }) => <button data-testid="diff-preview-apply-btn" onClick={onApply} />,
}));

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('react-syntax-highlighter', () => ({ Prism: () => null }));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({ oneDark: {} }));
vi.mock('@client/app/components/ProfileModal/ContentPreviewModal', () => ({ default: () => null }));
vi.mock('./TextViewer', () => ({ default: () => null }));
vi.mock('./MarkdownViewer', () => ({ default: () => null, UnmarkedCitedPassage: () => null }));
vi.mock('./DOCXViewer', () => ({ default: () => null }));
vi.mock('./CSVViewer', () => ({ default: () => null }));
vi.mock('./JSONViewer', () => ({ default: () => null }));
vi.mock('./XLSXViewer', () => ({ default: () => null }));
vi.mock('../GenAI/QuestMasterReply', () => ({ default: () => null }));
vi.mock('../Charts/MermaidChart', () => ({ default: () => null }));
vi.mock('../Charts/RechartsRenderer', () => ({ default: () => null }));
vi.mock('../Chess/ChessBoard', () => ({ default: () => null }));
vi.mock('../Chess/InteractiveChessBoard', () => ({ default: () => null }));
vi.mock('../common/DownloadMenu', () => ({ default: () => null, downloadFile: vi.fn(), copyToClipboard: vi.fn() }));

import KnowledgeViewer, { setKnowledgeViewer } from './KnowledgeViewer';
import useSessionLayout from '@client/app/hooks/useSessionLayout';

const STORAGE_LIMIT = 'File size exceeds storage limit';

const axiosError = (status: number, data: unknown) =>
  new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
    status,
    statusText: '',
    data,
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

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

const click = async (testId: string) => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
  });
};

describe('KnowledgeViewer storage-limit errors', () => {
  beforeEach(() => {
    h.post.mockReset();
    h.toastError.mockReset();
    h.toastSuccess.mockReset();
    h.submitError.current = undefined;
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

  describe('edit', () => {
    it('surfaces the server storage-limit message and re-throws', async () => {
      const error = axiosError(400, { error: STORAGE_LIMIT });
      h.post.mockRejectedValueOnce(error);
      await renderViewer();

      await click('edit-dialog-submit-btn');

      expect(h.post).toHaveBeenCalledWith(`/api/fabfiles/${FILE_ID}/edit`, expect.anything());
      expect(serverStorageLimitMessage(error)).toBe(STORAGE_LIMIT);
      expect(h.toastError).toHaveBeenCalledWith(STORAGE_LIMIT);
      expect(h.submitError.current).toBe(error);
    });

    it('falls back to the generic message for a non-quota error', async () => {
      h.post.mockRejectedValueOnce(axiosError(500, { error: 'boom' }));
      await renderViewer();

      await click('edit-dialog-submit-btn');

      expect(h.toastError).toHaveBeenCalledWith('Failed to generate edit');
      expect(h.submitError.current).toBeInstanceOf(AxiosError);
    });
  });

  describe('apply edit', () => {
    const openDiff = async () => {
      h.post.mockResolvedValueOnce({ data: { original: 'a', modified: 'b', diff: '-a\n+b' } });
      await renderViewer();
      await click('edit-dialog-submit-btn');
    };

    it('surfaces the server storage-limit message', async () => {
      await openDiff();
      const error = axiosError(400, { error: STORAGE_LIMIT });
      h.post.mockRejectedValueOnce(error);

      await click('diff-preview-apply-btn');

      expect(h.post).toHaveBeenLastCalledWith(`/api/fabfiles/${FILE_ID}/apply-edit`, { newContent: 'b' });
      expect(serverStorageLimitMessage(error)).toBe(STORAGE_LIMIT);
      expect(h.toastError).toHaveBeenCalledWith(STORAGE_LIMIT);
      expect(h.toastSuccess).not.toHaveBeenCalled();
    });

    it('falls back to the generic message for a non-quota error', async () => {
      await openDiff();
      h.post.mockRejectedValueOnce(new Error('network down'));

      await click('diff-preview-apply-btn');

      expect(h.toastError).toHaveBeenCalledWith('Failed to apply changes');
    });
  });
});

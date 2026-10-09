import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import KnowledgeModal, { useKnowledgeModal } from './KnowledgeModal';

const {
  addToNotebookContext,
  createFabFileOnServerWithUpload,
  activeNotebook,
  toastSuccess,
  toastError,
  invalidateQueries,
  setWorkBenchFiles,
} = vi.hoisted(() => ({
  addToNotebookContext: vi.fn(),
  createFabFileOnServerWithUpload: vi.fn(),
  activeNotebook: { value: { onScreen: true, sessionId: 's1' } as { onScreen: boolean; sessionId?: string | null } },
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  invalidateQueries: vi.fn(),
  setWorkBenchFiles: vi.fn(),
}));

vi.mock('@client/app/hooks/useActiveNotebook', () => ({ useActiveNotebook: () => activeNotebook.value }));
vi.mock('@client/app/hooks/useNotebookContextFiles', () => ({
  useNotebookContextFiles: () => ({ addToNotebookContext }),
}));
vi.mock('@client/app/utils/filesAPICalls', () => ({
  createFabFileOnServerWithUpload,
  updateFileUtility: vi.fn(),
  getFabFileByIdFromServer: vi.fn(),
}));
vi.mock('@client/app/utils/userAPICalls', () => ({ updateUserToServer: vi.fn() }));
vi.mock('@client/app/utils/fabFileUtils', () => ({ getContentFromFabfile: vi.fn() }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'user-1', systemFiles: [] } }),
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ setFilesMetaDataVersion: vi.fn(), currentSessionId: 's1' }),
  useWorkBenchActions: () => ({ setWorkBenchFiles }),
}));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction: () => () => {} }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ getQueryData: vi.fn(), invalidateQueries, setQueryData: vi.fn() }),
}));
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({}) }));
vi.mock('@client/app/components/help', () => ({ ContextHelpButton: () => null }));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError, info: vi.fn() } }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));

const appTheme = extendTheme({ ...getThemeConfig() });
const createdFile = { id: 'created-1', fileName: 'Notes.md', mimeType: 'text/markdown' };

const renderCreateModal = async () => {
  render(
    <CssVarsProvider theme={appTheme}>
      <KnowledgeModal />
    </CssVarsProvider>
  );
  act(() => {
    useKnowledgeModal.setState({ open: true, selectedFabFileId: null, viewOnly: false });
  });
  fireEvent.change(await screen.findByTestId('knowledge-modal-name-input'), { target: { value: 'Notes.md' } });
};

const save = () => fireEvent.click(screen.getByTestId('knowledge-modal-save-btn'));

describe('KnowledgeModal create-save attach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useKnowledgeModal.setState({ open: false, selectedFabFileId: null, viewOnly: false });
    createFabFileOnServerWithUpload.mockResolvedValue(createdFile);
    addToNotebookContext.mockResolvedValue(true);
  });

  it.each([
    { name: 'an existing notebook', notebook: { onScreen: true, sessionId: 's1' }, expectedId: 's1' },
    { name: '/new with no session yet', notebook: { onScreen: true, sessionId: null }, expectedId: null },
  ])('attaches the created file notebook-scoped on $name', async ({ notebook, expectedId }) => {
    activeNotebook.value = notebook;
    await renderCreateModal();
    save();
    await waitFor(() =>
      expect(addToNotebookContext).toHaveBeenCalledWith(expectedId, expect.objectContaining({ id: 'created-1' }), {
        propagateToProjects: false,
      })
    );
    expect(setWorkBenchFiles).not.toHaveBeenCalled();
  });

  it('does not attach when no notebook is on screen', async () => {
    activeNotebook.value = { onScreen: false };
    await renderCreateModal();
    save();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(createFabFileOnServerWithUpload).toHaveBeenCalled();
    expect(addToNotebookContext).not.toHaveBeenCalled();
  });

  it('still completes the save when the attach fails', async () => {
    activeNotebook.value = { onScreen: true, sessionId: 's1' };
    addToNotebookContext.mockRejectedValueOnce(new Error('PUT failed'));
    await renderCreateModal();
    save();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(addToNotebookContext).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    // Flush the rejected promise; an uncontained rejection fails the run.
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});

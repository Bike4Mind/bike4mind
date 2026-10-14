import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import KnowledgeModal, { useKnowledgeModal } from './KnowledgeModal';
import { getFabFileByIdFromServer } from '@client/app/utils/filesAPICalls';
import { getContentFromFabfile } from '@client/app/utils/fabFileUtils';

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
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

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

// Audio and video open as a player with their generation details; the text editor, format picker and
// system-instruction controls are for text files, and fetching a song as text would download it for nothing.
describe('KnowledgeModal media files', () => {
  const song = {
    id: 'song-1',
    fileName: 'Sea Song.mp3',
    mimeType: 'audio/mpeg',
    fileUrl: 'https://files.example.test/song.mp3',
    fileUrlExpireAt: new Date(Date.now() + 60 * 60 * 1000),
    sourceMetadata: {
      generation: { generator: 'music', provider: 'elevenlabs', modelId: 'music_v2', prompt: 'A folk song' },
    },
  };

  const openFile = async (file: object) => {
    vi.mocked(getFabFileByIdFromServer).mockResolvedValue(file as never);
    render(
      <CssVarsProvider theme={appTheme}>
        <KnowledgeModal />
      </CssVarsProvider>
    );
    act(() => {
      useKnowledgeModal.setState({ open: true, selectedFabFileId: (file as { id: string }).id, viewOnly: false });
    });
  };

  beforeEach(() => {
    vi.mocked(getContentFromFabfile).mockReset();
  });

  it('plays a song with its generation details, without fetching it as text', async () => {
    await openFile(song);
    expect(await screen.findByTestId('media-player-audio')).toBeTruthy();
    expect(screen.getByTestId('generation-details-model').textContent).toBe('music_v2');
    expect(getContentFromFabfile).not.toHaveBeenCalled();
    expect(screen.queryByTestId('knowledge-modal-name-input')).toBeNull();
    expect(screen.queryByText('System Instructions')).toBeNull();
    expect(screen.queryByTestId('knowledge-modal-save-btn')).toBeNull();
    expect(screen.getByText('Viewing: Sea Song.mp3')).toBeTruthy();
  });

  it('plays a video', async () => {
    await openFile({ ...song, id: 'clip-1', fileName: 'clip.mp4', mimeType: 'video/mp4' });
    expect(await screen.findByTestId('media-player-video')).toBeTruthy();
  });

  const image = {
    ...song,
    id: 'img-1',
    fileName: 'fox.png',
    mimeType: 'image/png',
    fileUrl: 'https://files.example.test/fox.png',
  };

  it('shows generation details for a generated image', async () => {
    await openFile({
      ...image,
      sourceMetadata: { generation: { generator: 'image', provider: 'test', prompt: 'a red fox' } },
    });
    expect(await screen.findByTestId('generation-details')).toBeTruthy();
    expect(screen.getByTestId('generation-details-prompt').textContent).toContain('a red fox');
  });

  it('shows no generation details for an image without generation metadata', async () => {
    await openFile({ ...image, sourceMetadata: undefined });
    expect(await screen.findByText('Editing: fox.png')).toBeTruthy();
    expect(screen.queryByTestId('generation-details')).toBeNull();
  });
});

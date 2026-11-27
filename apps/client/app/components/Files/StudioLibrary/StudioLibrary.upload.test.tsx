import type { IFabFileDocument } from '@bike4mind/common';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * The Library page through the real browser, search hook and upload mutation, against a fake /api/files/search that
 * applies the source filters the way the server does (fabFileService/search.ts): `generated` keeps only generated
 * files, `uploaded` only the rest. Type, shared, owned and pagination are ignored. The browser internals are mocked
 * on purpose: this pins the request filters and the tiles shown, not the browser's component tree.
 */

type StoredFile = IFabFileDocument & { generated: boolean };
type SearchParams = { filters?: { generated?: boolean; uploaded?: boolean } };

const { store, searchRequests, createFabFileOnServerWithUpload } = vi.hoisted(() => ({
  store: [] as StoredFile[],
  searchRequests: [] as SearchParams[],
  createFabFileOnServerWithUpload: vi.fn(),
}));

const fakeFile = (id: string, fileName: string, generated: boolean): StoredFile =>
  ({ id, fileName, mimeType: 'image/png', fileSize: 1, generated, tags: [] }) as unknown as StoredFile;

vi.mock('@client/app/contexts/ApiContext', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/contexts/ApiContext')>()),
  api: {
    get: async (url: string, options?: { params?: SearchParams }) => {
      if (url !== '/api/files/search') return { data: { data: [], total: 0, hasMore: false } };
      const params = options?.params ?? {};
      searchRequests.push(params);
      const files = store.filter(
        file => !(params.filters?.generated && !file.generated) && !(params.filters?.uploaded && file.generated)
      );
      return { data: { data: files, total: files.length, hasMore: false } };
    },
  },
}));

vi.mock('@client/app/utils/filesAPICalls', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/utils/filesAPICalls')>()),
  createFabFileOnServerWithUpload: (...args: unknown[]) => createFabFileOnServerWithUpload(...args),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@client/app/hooks/data/tag', () => ({
  useGetFileTags: () => ({ data: [] }),
  useToggleTagToFiles: () => ({ mutateAsync: vi.fn() }),
  useCreateFileTag: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetDataLakes: () => ({ data: [] }),
  useAddFilesToLake: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@client/app/hooks/data/fileStars', () => ({
  useGenerationModelIds: () => ({ data: [] }),
  useStarredFileIds: () => ({ data: new Set<string>() }),
  useToggleFileStar: () => ({ mutate: vi.fn() }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({ useUpdateSession: () => ({ mutate: vi.fn() }) }));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => vi.fn() }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'u1' } }) }));
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (s: { model: string }) => unknown) => selector({ model: 'gpt' }),
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: 's1', currentSession: null }),
  useWorkBenchFiles: () => [],
  useWorkBenchStore: { getState: () => ({ setWorkBenchFiles: vi.fn() }) },
}));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction: () => () => {} }),
}));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('@client/app/stores/useDataLakeWizardStore', () => ({
  useDataLakeWizardStore: (selector: (s: { openManager: () => void }) => unknown) => selector({ openManager: vi.fn() }),
}));
vi.mock('../../Knowledge/KnowledgeModal', () => {
  const state = { setOpen: vi.fn(), setSelectedFabFileId: vi.fn(), setViewOnly: vi.fn() };
  return { useKnowledgeModal: (selector: (s: typeof state) => unknown) => selector(state) };
});
// One tile per file is all this pins; the real tile is covered by Browser/Item.test.tsx.
vi.mock('../Browser/Item', () => ({
  default: ({ file }: { file: IFabFileDocument }) => <div data-testid="studio-library-tile">{file.fileName}</div>,
}));
vi.mock('../Browser/ViewActions', () => ({ default: () => null }));
vi.mock('../Browser/TagSidebar', () => ({ default: () => null }));
vi.mock('../Browser/TagView', () => ({ TagViewPanel: () => null }));
vi.mock('../Browser/HomeView', () => ({ HomeViewPanel: () => null }));
// The mobile bar carries a second upload input; the desktop one is enough here.
vi.mock('../Browser/MobileSearchFilter', () => ({ MobileSearchFilter: () => null }));
vi.mock('../Browser/TagFilter', () => ({ default: () => null }));
vi.mock('../GenerateAudio/GenerateAudioButton', () => ({ default: () => null }));
vi.mock('../../common/FileStorageBar', () => ({ default: () => null }));
vi.mock('../../common/StorageBreakdown', () => ({ default: () => null }));
vi.mock('../../common/ShareModal', () => ({ default: () => null }));
vi.mock('../../Knowledge/CreateKnowledgeFromUrl', () => ({ default: () => null }));
vi.mock('../../Tag/Form', () => ({ default: () => null }));
vi.mock('../../ResarchEngine/Modal', () => ({ default: () => null }));
vi.mock('@client/app/components/MobileTopBar', () => ({ MobileTopBar: () => null }));
vi.mock('@client/app/components/help', () => ({ FieldTooltip: () => null }));

import { StudioLibrary } from '.';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderLibrary = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <StudioLibrary />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const tileNames = () => screen.queryAllByTestId('studio-library-tile').map(tile => tile.textContent);

describe('StudioLibrary - uploads', () => {
  beforeEach(() => {
    store.length = 0;
    searchRequests.length = 0;
    createFabFileOnServerWithUpload.mockReset();
  });

  it('asks for every source, as the production picker does, so uploads list beside generated files', async () => {
    store.push(fakeFile('g1', 'generated.png', true), fakeFile('u1', 'uploaded.png', false));
    renderLibrary();

    await waitFor(() => expect(tileNames()).toEqual(expect.arrayContaining(['generated.png', 'uploaded.png'])));
    expect(searchRequests.length).toBeGreaterThan(0);
    for (const request of searchRequests) {
      expect(request.filters?.generated).toBeUndefined();
      expect(request.filters?.uploaded).toBeUndefined();
    }
    expect(screen.queryByTestId('file-browser-locked-filter-chip-source')).not.toBeInTheDocument();
    expect(screen.getByTestId('file-browser-generated-filter-btn')).toBeInTheDocument();
  });

  it('narrows the grid to generated files with the Generated toggle, and widens it again', async () => {
    store.push(fakeFile('g1', 'generated.png', true), fakeFile('u1', 'uploaded.png', false));
    renderLibrary();
    await waitFor(() => expect(tileNames()).toEqual(expect.arrayContaining(['generated.png', 'uploaded.png'])));

    fireEvent.click(screen.getByTestId('file-browser-generated-filter-btn'));
    await waitFor(() => expect(tileNames()).toEqual(['generated.png']));
    expect(searchRequests.at(-1)?.filters?.generated).toBe(true);

    fireEvent.click(screen.getByTestId('file-browser-generated-filter-btn'));
    await waitFor(() => expect(tileNames()).toEqual(expect.arrayContaining(['generated.png', 'uploaded.png'])));
  });

  it('shows a file uploaded from the page without a reload', async () => {
    createFabFileOnServerWithUpload.mockImplementation(async (parameters: { fileName: string }) => {
      const created = fakeFile('u2', parameters.fileName, false);
      store.push(created);
      return created;
    });
    renderLibrary();
    await waitFor(() => expect(screen.getByText('You have no files')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('upload-actions-file-input'), {
      target: { files: [new File(['x'], 'photo.jpg', { type: 'image/jpeg' })] },
    });

    await waitFor(() => expect(tileNames()).toEqual(['photo.jpg']));
    expect(createFabFileOnServerWithUpload).toHaveBeenCalledTimes(1);
  });
});

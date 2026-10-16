import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { KnowledgeType, SupportedFabFileMimeTypes } from '@bike4mind/common';
import type { IFabFileDocument } from '@bike4mind/common';
import { getFileIcon } from './Item';
import FileBrowserItem from './Item';
import { FileBrowserInstanceProvider, FileBrowserInstanceValue } from './instanceContext';

// Keep the ListItem/GridItem render tests focused on the image-moderation
// gating rather than the full file-actions menu, tags, and sharing chrome -
// mock out the pieces that pull in unrelated context requirements
// (react-i18next, confirmation dialogs, etc).
vi.mock('./ItemActions', () => ({ default: () => <div data-testid="file-browser-item-actions" /> }));
const viewer = vi.hoisted(() => ({ setSelectedFabFileId: vi.fn(), setViewOnly: vi.fn(), setOpen: vi.fn() }));
vi.mock('@client/app/components/Knowledge/KnowledgeModal', () => ({
  useKnowledgeModal: (selector: (state: typeof viewer) => unknown) => selector(viewer),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: null }),
}));
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useUpdateFabFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const queryClient = new QueryClient();
const renderWithProviders = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <TestWrapper>{ui}</TestWrapper>
    </QueryClientProvider>
  );

const makeFile = (overrides: Partial<IFabFileDocument>): IFabFileDocument =>
  ({
    id: 'test-id',
    fileName: 'test-file',
    type: KnowledgeType.FILE,
    mimeType: SupportedFabFileMimeTypes.TXT_PLAIN,
    fileUrl: undefined,
    presignedUrl: undefined,
    ...overrides,
  }) as IFabFileDocument;

describe('getFileIcon', () => {
  it('renders an img thumbnail for a clean image file with a URL', () => {
    const file = makeFile({
      mimeType: SupportedFabFileMimeTypes.PNG,
      fileUrl: 'https://example.com/img.png',
      moderationStatus: 'clean',
    });
    render(<TestWrapper>{getFileIcon(file, 48)}</TestWrapper>);
    const img = screen.getByRole('img');
    expect(img).toBeTruthy();
    expect((img as HTMLImageElement).src).toContain('example.com/img.png');
    expect((img as HTMLElement).getAttribute('loading')).toBe('lazy');
  });

  // A held/blocked uploaded image FabFile is returned WITHOUT a serveable URL,
  // so getFileIcon must key off moderationStatus rather than falling back to a
  // generic icon.
  it('renders the scanning placeholder for an image with no URL and unresolved (or missing) moderation status', () => {
    const file = makeFile({ mimeType: SupportedFabFileMimeTypes.PNG });
    render(<TestWrapper>{getFileIcon(file, 48)}</TestWrapper>);
    expect(screen.getByTestId('image-moderation-scanning')).toBeInTheDocument();
  });

  it('renders the blocked placeholder for a blocked image, even if it were to carry a URL', () => {
    const file = makeFile({ mimeType: SupportedFabFileMimeTypes.PNG, moderationStatus: 'blocked' });
    render(<TestWrapper>{getFileIcon(file, 48)}</TestWrapper>);
    expect(screen.getByTestId('image-moderation-blocked')).toBeInTheDocument();
  });

  it.each([
    [SupportedFabFileMimeTypes.PDF, 'PictureAsPdf'],
    [SupportedFabFileMimeTypes.DOCX, 'TextSnippet'],
    [SupportedFabFileMimeTypes.PPTX, 'Slideshow'],
    [SupportedFabFileMimeTypes.XLSX, 'TableChart'],
    [SupportedFabFileMimeTypes.TXT_PLAIN, 'Article'],
    [SupportedFabFileMimeTypes.TXT_MARKDOWN, 'Dashboard'],
    [SupportedFabFileMimeTypes.HTML, 'Code'],
    [SupportedFabFileMimeTypes.XML, 'Tag'],
    [SupportedFabFileMimeTypes.JSON, 'Description'],
    [SupportedFabFileMimeTypes.CSV, 'DataObject'],
    [SupportedFabFileMimeTypes.YAML, 'DataObject'],
    [SupportedFabFileMimeTypes.TOML, 'DataObject'],
  ])('renders an svg icon for %s', mimeType => {
    const file = makeFile({ mimeType });
    const { container } = render(<TestWrapper>{getFileIcon(file, 48)}</TestWrapper>);
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders generic fallback icon for unrecognized MIME types', () => {
    const file = makeFile({ mimeType: 'application/x-unknown' });
    const { container } = render(<TestWrapper>{getFileIcon(file, 48)}</TestWrapper>);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders generic fallback icon for URL knowledge type', () => {
    const file = makeFile({ type: KnowledgeType.URL, mimeType: SupportedFabFileMimeTypes.PDF });
    const { container } = render(<TestWrapper>{getFileIcon(file, 48)}</TestWrapper>);
    expect(container.querySelector('svg')).toBeTruthy();
  });
});

// ListItem and GridItem used to render a raw <img> off
// `file.fileUrl || file.presignedUrl` directly, bypassing the moderation-aware
// `icon` (getFileIcon) they already compute. A held image has `presignedUrl`
// set (a PUT-signed URL, useless for GET) but no `fileUrl`, so that truthy
// check let the raw <img> branch win and render a broken image instead of the
// scanning placeholder. These tests pin the fix: gate the raw <img> branch on
// `isImageServeable(file)` so a non-serveable image always falls through to
// the placeholder.
describe('FileBrowserItem image moderation gating', () => {
  const heldImageFile = makeFile({
    fileName: 'held-image.png',
    mimeType: SupportedFabFileMimeTypes.PNG,
    moderationStatus: 'pending',
    fileUrl: undefined,
    presignedUrl: 'https://example.com/held-image-put-signed-url',
  });

  it('ListItem renders the scanning placeholder, not a raw <img>, for a held image with only a presignedUrl', () => {
    renderWithProviders(<FileBrowserItem file={heldImageFile} viewType="list" />);
    expect(screen.getByTestId('image-moderation-scanning')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('GridItem renders the scanning placeholder, not a raw <img>, for a held image with only a presignedUrl', () => {
    renderWithProviders(<FileBrowserItem file={heldImageFile} viewType="grid" />);
    expect(screen.getByTestId('image-moderation-scanning')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});

// The "Added" indicator is driven by config.addedFileIds from the instance context,
// so an embedded picker can flag files already present in its own list.
describe('FileBrowserItem added-indicator', () => {
  const file = makeFile({ id: 'added-1', fileName: 'already-added.txt' });

  const makeInstance = (addedFileIds?: Set<string>): FileBrowserInstanceValue => ({
    selectedIds: new Set<string>(),
    setSelectedIds: vi.fn(),
    open: true,
    setOpen: vi.fn(),
    fileToShare: null,
    setFileToShare: vi.fn(),
    config: { addedFileIds },
  });

  const renderWithInstance = (viewType: 'list' | 'grid', addedFileIds?: Set<string>) =>
    renderWithProviders(
      <FileBrowserInstanceProvider value={makeInstance(addedFileIds)}>
        <FileBrowserItem file={file} viewType={viewType} />
      </FileBrowserInstanceProvider>
    );

  it.each(['list', 'grid'] as const)('%s shows the Added badge when the file id is in addedFileIds', viewType => {
    renderWithInstance(viewType, new Set(['added-1']));
    expect(screen.getByTestId('file-browser-item-added-badge')).toBeInTheDocument();
  });

  it.each(['list', 'grid'] as const)('%s hides the Added badge when the file is not added', viewType => {
    renderWithInstance(viewType, new Set(['some-other-id']));
    expect(screen.queryByTestId('file-browser-item-added-badge')).toBeNull();
  });
});

// Audio plays inline through the shared MediaPlayer in both views, loading nothing until played so a long list stays
// cheap. Video plays inline only in a grid card: a list row is one line tall, so it shows a poster-frame thumbnail that
// opens the viewer. Download stays in the row's actions menu.
describe('FileBrowserItem inline media', () => {
  const audioFile = makeFile({ fileName: 'song.mp3', mimeType: 'audio/mpeg', fileUrl: 'https://example.com/song.mp3' });
  const videoFile = makeFile({ fileName: 'clip.mp4', mimeType: 'video/mp4', fileUrl: 'https://example.com/clip.mp4' });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['list', 'grid'] as const)('%s plays an audio file without preloading it', viewType => {
    renderWithProviders(<FileBrowserItem file={audioFile} viewType={viewType} />);
    expect(screen.getByTestId('media-player-audio').getAttribute('preload')).toBe('none');
    expect(screen.queryByTestId('media-player-download-btn')).toBeNull();
  });

  it('grid plays a video file with its poster frame', () => {
    renderWithProviders(<FileBrowserItem file={videoFile} viewType="grid" />);
    expect(screen.getByTestId('media-player-video').getAttribute('preload')).toBe('metadata');
  });

  it('list shows a video as a full row with a thumbnail instead of an inline player', () => {
    renderWithProviders(<FileBrowserItem file={videoFile} viewType="list" />);
    expect(screen.queryByTestId('media-player-video')).toBeNull();
    expect(screen.getByTestId('file-browser-item-name').textContent).toBe('clip.mp4');
    expect(screen.getByTestId('file-browser-item-actions')).toBeInTheDocument();
    const thumbnail = screen.getByTestId('file-browser-item-video-thumbnail');
    expect(thumbnail.querySelector('video')?.getAttribute('preload')).toBe('metadata');
  });

  it('list opens the viewer from the video thumbnail without toggling the row selection', () => {
    const setSelectedIds = vi.fn();
    renderWithProviders(
      <FileBrowserInstanceProvider
        value={{
          selectedIds: new Set<string>(),
          setSelectedIds,
          open: true,
          setOpen: vi.fn(),
          fileToShare: null,
          setFileToShare: vi.fn(),
          config: {},
        }}
      >
        <FileBrowserItem file={videoFile} viewType="list" />
      </FileBrowserInstanceProvider>
    );
    fireEvent.click(screen.getByTestId('file-browser-item-video-thumbnail'));
    expect(viewer.setSelectedFabFileId).toHaveBeenCalledWith(videoFile.id);
    expect(viewer.setViewOnly).toHaveBeenCalledWith(false);
    expect(viewer.setOpen).toHaveBeenCalledWith(true);
    expect(setSelectedIds).not.toHaveBeenCalled();
  });

  it('list falls back to the video icon, still opening the viewer, when the thumbnail fails to load', () => {
    renderWithProviders(<FileBrowserItem file={videoFile} viewType="list" />);
    const thumbnail = screen.getByTestId('file-browser-item-video-thumbnail');
    fireEvent.error(thumbnail.querySelector('video') as HTMLVideoElement);
    expect(thumbnail.querySelector('video')).toBeNull();
    expect(thumbnail.querySelector('[data-testid="VideocamIcon"]')).toBeTruthy();
    fireEvent.click(thumbnail);
    expect(viewer.setOpen).toHaveBeenCalledWith(true);
  });

  it('list never hands an expired URL to the thumbnail', () => {
    const expired = { ...videoFile, fileUrlExpireAt: new Date(Date.now() - 1000) } as IFabFileDocument;
    renderWithProviders(<FileBrowserItem file={expired} viewType="list" />);
    expect(screen.getByTestId('file-browser-item-video-thumbnail').querySelector('video')).toBeNull();
  });

  it('renders no player for a media file with no URL', () => {
    renderWithProviders(<FileBrowserItem file={makeFile({ mimeType: 'video/mp4' })} viewType="list" />);
    expect(screen.queryByTestId('media-player-video')).toBeNull();
  });

  it('gives a video file its own icon', () => {
    const { container } = render(<TestWrapper>{getFileIcon(makeFile({ mimeType: 'video/mp4' }), 48)}</TestWrapper>);
    expect(container.querySelector('[data-testid="VideocamIcon"]')).toBeTruthy();
  });
});

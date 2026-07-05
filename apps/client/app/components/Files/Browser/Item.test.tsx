import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { KnowledgeType, SupportedFabFileMimeTypes } from '@bike4mind/common';
import type { IFabFileDocument } from '@bike4mind/common';
import { getFileIcon } from './Item';
import FileBrowserItem from './Item';

// Keep the ListItem/GridItem render tests focused on the image-moderation
// gating rather than the full file-actions menu, tags, and sharing chrome -
// mock out the pieces that pull in unrelated context requirements
// (react-i18next, confirmation dialogs, etc).
vi.mock('./ItemActions', () => ({ default: () => null }));
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

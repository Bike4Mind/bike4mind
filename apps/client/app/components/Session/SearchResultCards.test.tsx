import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';
import SearchResultCards from './SearchResultCards';

// Tiles are fetched through the authenticated API client and rendered as blob: URLs - a bare
// <img src="/api/search-image?..."> would 401, since the bearer JWT only rides on axios.
vi.mock('@client/app/contexts/apiClient', () => ({ api: { get: vi.fn() } }));
import { api } from '@client/app/contexts/apiClient';

const apiGet = vi.mocked(api.get);

/** Serve every image except the ones named in `failing`, which reject as the proxy would. */
function serveImages(failing: string[] = []) {
  apiGet.mockImplementation(async (path: string) => {
    if (failing.some(url => path.includes(encodeURIComponent(url)))) throw new Error('404');
    return { data: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }) } as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:mock/${++n}`);
  URL.revokeObjectURL = vi.fn();
  serveImages();
});

const appTheme = extendTheme({ ...getThemeConfig() });
const renderCards = (content: string, replyComplete = false) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SearchResultCards content={content} replyComplete={replyComplete} />
    </CssVarsProvider>
  );

const block = (cards: unknown[]) => JSON.stringify({ cards });

const oneCard = block([
  {
    name: 'Orient Bambino',
    note: 'The default answer to this exact question.',
    meta: '~$200',
    url: 'https://orientwatch.co/bambino',
    images: [
      { url: 'https://cdn.example.com/a.jpg', source: 'orientwatch.co' },
      { url: 'https://cdn.example.com/b.jpg', source: 'jomashop' },
    ],
  },
]);

describe('SearchResultCards', () => {
  it('renders the model-authored name, note and meta line', () => {
    renderCards(oneCard);

    expect(screen.getByText('Orient Bambino')).toBeInTheDocument();
    expect(screen.getByText('The default answer to this exact question.')).toBeInTheDocument();
    expect(screen.getByText('~$200')).toBeInTheDocument();
  });

  it('links the card to its URL and opens it safely in a new tab', () => {
    renderCards(oneCard);

    const card = screen.getByTestId('search-result-card');
    expect(card).toHaveAttribute('href', 'https://orientwatch.co/bambino');
    expect(card).toHaveAttribute('target', '_blank');
    expect(card).toHaveAttribute('rel', 'noopener noreferrer');
  });

  // The app CSP pins img-src to an allowlist that can never contain a search-result host, so the
  // origin URL must never reach an <img>. jsdom enforces no CSP, hence asserting the path taken
  // rather than inferring it from a successful render.
  it('requests every image through the same-origin proxy, never the origin host', async () => {
    const { container } = renderCards(oneCard);

    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2));
    expect(apiGet.mock.calls.map(([path]) => path)).toEqual([
      '/api/search-image?url=https%3A%2F%2Fcdn.example.com%2Fa.jpg',
      '/api/search-image?url=https%3A%2F%2Fcdn.example.com%2Fb.jpg',
    ]);
    for (const img of container.querySelectorAll('img')) {
      expect(img.getAttribute('src')).toMatch(/^blob:/);
    }
  });

  it('attributes each tile to the host its picture came from', async () => {
    renderCards(oneCard);

    expect(await screen.findByText('orientwatch.co')).toBeInTheDocument();
    expect(screen.getByText('jomashop')).toBeInTheDocument();
  });

  it('releases each blob URL when the row unmounts', async () => {
    const { container, unmount } = renderCards(oneCard);
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2));

    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('replaces an image the proxy refuses with a placeholder, leaving the others alone', async () => {
    serveImages(['https://cdn.example.com/a.jpg']);
    const { container } = renderCards(oneCard);

    expect(await screen.findByText('Image unavailable')).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(1));
  });

  it('shows a skeleton, not raw JSON, while the block is still streaming', () => {
    renderCards('{"cards":[{"name":"Orient Bam');

    expect(screen.getByTestId('search-result-cards-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(/"cards"/)).not.toBeInTheDocument();
  });

  it('drops a never-closed fence once the reply is complete, rather than leaving a skeleton', () => {
    const { container } = renderCards('{"cards":[{"name":"Orient Bam', true);

    expect(container).toBeEmptyDOMElement();
  });

  it('drops an empty fence body once the reply is complete', () => {
    const { container } = renderCards('', true);

    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the skeleton for a half-written fence while the reply is still streaming', () => {
    renderCards('{"cards":[{"name":"Orient Bam', false);

    expect(screen.getByTestId('search-result-cards-skeleton')).toBeInTheDocument();
  });

  it('renders two same-named cards independently, so one failed image does not affect the other', async () => {
    serveImages(['https://cdn.example.com/1.jpg']);
    const { container } = renderCards(
      block([
        { name: 'Bambino', images: ['https://cdn.example.com/1.jpg'] },
        { name: 'Bambino', images: ['https://cdn.example.com/2.jpg'] },
      ])
    );

    expect(screen.getAllByTestId('search-result-card')).toHaveLength(2);
    await waitFor(() => expect(screen.getAllByText('Image unavailable')).toHaveLength(1));
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('renders nothing for a block that finished malformed', () => {
    const { container } = renderCards('{"cards":[]}');

    expect(container).toBeEmptyDOMElement();
  });

  it('renders a single full-width tile when the card has one image', async () => {
    const { container } = renderCards(block([{ name: 'Solo', images: ['https://cdn.example.com/only.jpg'] }]));

    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(1));
    expect(screen.getByText('Solo')).toBeInTheDocument();
  });
});

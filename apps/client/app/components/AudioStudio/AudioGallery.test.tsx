import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ query: {} as Record<string, unknown>, search: vi.fn() }));

vi.mock('@client/app/hooks/data/fabFileSearch', () => ({
  useInfiniteSearchFabFiles: (...args: unknown[]) => {
    h.search(...args);
    return h.query;
  },
}));
vi.mock('./GeneratedAudioCard', () => ({
  default: ({ mode, file }: { mode: string; file: { id: string } }) => (
    <div data-testid="audio-card">{`${mode}:${file.id}`}</div>
  ),
}));

import { SoundEffectsGallery, SpeechGallery } from './AudioGallery';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderGallery = (ui: React.ReactElement) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const loaded = (ids: string[]) => {
  h.query = {
    data: { pages: [{ data: ids.map(id => ({ id })) }] },
    isPending: false,
    isFetchNextPageError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  loaded(['a']);
});

describe('SpeechGallery', () => {
  it('asks for generated speech files, newest first, and renders a card each', () => {
    loaded(['new', 'old']);
    renderGallery(<SpeechGallery />);

    expect(h.search).toHaveBeenCalledWith({
      filters: { generated: true, tags: ['speech'] },
      order: { by: 'createdAt', direction: 'desc' },
    });
    expect(screen.getAllByTestId('audio-card').map(node => node.textContent)).toEqual(['tts:new', 'tts:old']);
  });

  it('explains itself when there is nothing yet', () => {
    loaded([]);
    renderGallery(<SpeechGallery />);
    expect(screen.getByTestId('speech-gallery-empty')).toHaveTextContent('Speech clips you generate will appear here.');
  });
});

describe('SoundEffectsGallery', () => {
  it('asks for generated sound effects, under their own tag', () => {
    renderGallery(<SoundEffectsGallery />);

    expect(h.search).toHaveBeenCalledWith({
      filters: { generated: true, tags: ['sound-effect'] },
      order: { by: 'createdAt', direction: 'desc' },
    });
    expect(screen.getByTestId('audio-card')).toHaveTextContent('sound-effects:a');
  });

  it('explains itself when there is nothing yet', () => {
    loaded([]);
    renderGallery(<SoundEffectsGallery />);
    expect(screen.getByTestId('sound-effects-gallery-empty')).toHaveTextContent(
      'Sound effects you generate will appear here.'
    );
  });

  it('shows a spinner until the first page arrives', () => {
    h.query = {
      data: undefined,
      isPending: true,
      isFetchNextPageError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    };
    renderGallery(<SoundEffectsGallery />);
    expect(screen.getByTestId('sound-effects-gallery-loading')).toBeInTheDocument();
  });
});

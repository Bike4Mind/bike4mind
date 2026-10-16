import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateMusicGenerationBody, CreateVideoGenerationBody } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  models: {} as Record<string, unknown>,
  musicModels: {} as Record<string, unknown>,
  useDocumentTitle: vi.fn(),
  mutate: vi.fn(),
  musicMutate: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }));
vi.mock('@client/app/hooks/data/musicGenerations', () => ({
  useMusicModels: () => h.musicModels,
  useCreateMusicGeneration: () => ({ mutate: h.musicMutate, isPending: false }),
}));
vi.mock('@client/app/components/MusicStudio/MusicGallery', () => ({
  default: () => <div data-testid="music-gallery-stub" />,
}));
vi.mock('@client/app/components/MusicStudio/MusicStudioForm', () => ({
  default: ({ onSubmit }: { onSubmit: (body: CreateMusicGenerationBody) => void }) => (
    <button data-testid="music-form-stub" onClick={() => onSubmit({ model: 'test-music', prompt: 'p' })} />
  ),
}));

vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: h.useDocumentTitle }));
vi.mock('@client/app/hooks/data/videoGenerations', () => ({
  useVideoModels: () => h.models,
  useCreateVideoGeneration: () => ({ mutate: h.mutate, isPending: false }),
}));
vi.mock('@client/app/components/VideoStudio/VideoGallery', () => ({
  default: () => <div data-testid="video-gallery-stub" />,
}));
vi.mock('@client/app/components/VideoStudio/VideoStudioForm', () => ({
  default: ({ onSubmit }: { onSubmit: (body: CreateVideoGenerationBody) => void }) => (
    <button data-testid="video-form-stub" onClick={() => onSubmit({ model: 'm', prompt: 'p' })} />
  ),
}));

import { rangeModel } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import type { StudioModality } from '@client/app/components/Studio/studioModality';
import StudioPage from './$modality';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPage = (modality: StudioModality = 'video') =>
  render(
    <CssVarsProvider theme={appTheme}>
      <StudioPage modality={modality} />
    </CssVarsProvider>
  );

beforeEach(() => vi.clearAllMocks());

describe('StudioPage (video)', () => {
  it('sets the tab title and keeps the video page test id under the Studio heading', () => {
    h.models = { isPending: true, data: undefined };
    renderPage();
    expect(h.useDocumentTitle).toHaveBeenCalledWith('Video Studio');
    expect(screen.getByRole('heading', { level: 1, name: 'Studio' })).toBeInTheDocument();
    expect(screen.getByTestId('video-studio-page')).toBeInTheDocument();
  });

  it('renders the form and the gallery when a model is usable', () => {
    h.models = { data: [rangeModel], isPending: false, isError: false };
    renderPage();
    screen.getByTestId('video-form-stub').click();
    expect(h.mutate).toHaveBeenCalledWith({ model: 'm', prompt: 'p' });
    expect(screen.getByTestId('video-gallery-stub')).toBeInTheDocument();
  });

  it('explains that video is not enabled, and still shows past videos', () => {
    h.models = { data: [], isPending: false, isError: false };
    renderPage();
    expect(screen.getByTestId('video-studio-empty')).toHaveTextContent(
      'Video generation is not available for your account yet.'
    );
    expect(screen.queryByTestId('video-form-stub')).not.toBeInTheDocument();
    expect(screen.getByTestId('video-gallery-stub')).toBeInTheDocument();
  });

  it('shows loading and error states for the models', () => {
    h.models = { data: undefined, isPending: true, isError: false };
    const { unmount } = renderPage();
    expect(screen.getByTestId('video-studio-loading')).toBeInTheDocument();
    unmount();
    h.models = { data: undefined, isPending: false, isError: true };
    renderPage();
    expect(screen.getByTestId('video-studio-error')).toHaveTextContent(
      'Could not load the video models. Refresh to try again.'
    );
  });

  it('keeps the form when a background models refetch failed', () => {
    h.models = { data: [rangeModel], isPending: false, isError: true };
    renderPage();
    expect(screen.getByTestId('video-form-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('video-studio-error')).not.toBeInTheDocument();
  });
});

describe('StudioPage tabs', () => {
  it('shows a Video and a Music tab, with the current modality selected', () => {
    h.models = { data: [rangeModel], isPending: false, isError: false };
    renderPage();
    expect(screen.getByTestId('studio-tab-video')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('studio-tab-music')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('studio-tab-music')).toHaveTextContent('Music');
  });

  it('navigates to the modality route when another tab is picked', () => {
    h.models = { data: [rangeModel], isPending: false, isError: false };
    renderPage();
    fireEvent.click(screen.getByTestId('studio-tab-music'));
    expect(h.navigate).toHaveBeenCalledWith({ to: '/studio/$modality', params: { modality: 'music' } });
  });

  it('does not navigate when the current tab is picked again', () => {
    h.models = { data: [rangeModel], isPending: false, isError: false };
    renderPage();
    fireEvent.click(screen.getByTestId('studio-tab-video'));
    expect(h.navigate).not.toHaveBeenCalled();
  });
});

describe('StudioPage (music)', () => {
  it('renders the music form and gallery when a music model is usable', () => {
    h.musicModels = { data: [{ id: 'test-music', display_name: 'Test' }], isPending: false, isError: false };
    renderPage('music');
    expect(h.useDocumentTitle).toHaveBeenCalledWith('Music Studio');
    expect(screen.getByRole('heading', { level: 1, name: 'Studio' })).toBeInTheDocument();
    expect(screen.getByTestId('music-studio-page')).toBeInTheDocument();
    expect(screen.getByTestId('studio-tab-music')).toHaveAttribute('aria-selected', 'true');
    screen.getByTestId('music-form-stub').click();
    expect(h.musicMutate).toHaveBeenCalledWith({ model: 'test-music', prompt: 'p' });
    expect(screen.getByTestId('music-gallery-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('video-form-stub')).not.toBeInTheDocument();
  });

  it('explains that music is not enabled, and still shows past songs', () => {
    h.musicModels = { data: [], isPending: false, isError: false };
    renderPage('music');
    expect(screen.getByTestId('music-studio-empty')).toHaveTextContent(
      'Music generation is not available for your account yet.'
    );
    expect(screen.getByTestId('music-gallery-stub')).toBeInTheDocument();
  });

  it('shows loading and error states for the music models', () => {
    h.musicModels = { data: undefined, isPending: true, isError: false };
    const { unmount } = renderPage('music');
    expect(screen.getByTestId('music-studio-loading')).toBeInTheDocument();
    unmount();
    h.musicModels = { data: undefined, isPending: false, isError: true };
    renderPage('music');
    expect(screen.getByTestId('music-studio-error')).toHaveTextContent(
      'Could not load the music models. Refresh to try again.'
    );
  });
});

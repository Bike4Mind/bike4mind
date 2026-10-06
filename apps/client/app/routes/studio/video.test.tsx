import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateVideoGenerationBody } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  models: {} as Record<string, unknown>,
  mutate: vi.fn(),
}));

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
import VideoStudioPage from './video';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <VideoStudioPage />
    </CssVarsProvider>
  );

beforeEach(() => vi.clearAllMocks());

describe('VideoStudioPage', () => {
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
    expect(screen.getByTestId('video-studio-empty')).toBeInTheDocument();
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
    expect(screen.getByTestId('video-studio-error')).toBeInTheDocument();
  });
});

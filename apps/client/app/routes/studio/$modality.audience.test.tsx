import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

// Runs the real useStudioFeature (unlike $modality.test.tsx), so who sees which Studio comes from the shared
// audience rule in @bike4mind/common, with only the viewer and the settings stubbed.
const h = vi.hoisted(() => ({
  isAdmin: false,
  enabledSettings: new Set<string>(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (state: { isAdmin: boolean }) => unknown) => selector({ isAdmin: h.isAdmin }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled: (key: string) => h.enabledSettings.has(key), isLoading: false }),
}));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ authedSettingsLoaded: true, error: null }),
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (selector: (state: { accessToken: string | null }) => unknown) => selector({ accessToken: 'token' }),
}));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@client/app/components/NotFound', () => ({ default: () => <div data-testid="not-found-stub" /> }));
vi.mock('@client/app/components/common/PageFrame', () => ({
  default: ({ testId, children }: { testId: string; children: ReactNode }) => (
    <div data-testid={testId}>{children}</div>
  ),
}));
vi.mock('@client/app/components/Studio/v2/StudioCreateV2Page', () => ({
  default: ({ medium }: { medium: string }) => <div data-testid="create-v2-stub" data-medium={medium} />,
}));
vi.mock('@client/app/components/Studio/v2/studioCreateMedia', () => ({
  STUDIO_V2_ONLY_MEDIUM_FEATURE: { image: 'image' },
}));
vi.mock('@client/app/components/Studio/studioModalityRegistry', async () => {
  const { STUDIO_MODALITIES } = await import('@client/app/components/Studio/studioModality');
  const definition = (modality: string) => ({
    tabLabel: modality,
    galleryTitle: `${modality} gallery`,
    testId: `${modality}-studio`,
    Workspace: () => <div data-testid="legacy-workspace-stub" />,
    Gallery: () => null,
  });
  return { STUDIO_MODALITY_DEFINITIONS: Object.fromEntries(STUDIO_MODALITIES.map(m => [m, definition(m)])) };
});

import StudioPage from './$modality';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderPage = (modality: 'video' | 'image') =>
  render(
    <CssVarsProvider theme={appTheme}>
      <StudioPage modality={modality} />
    </CssVarsProvider>
  );

beforeEach(() => {
  h.isAdmin = false;
  h.enabledSettings = new Set();
});

describe('StudioPage for a non-admin', () => {
  it('shows Create v2 when EnableStudioCreateV2 is on', () => {
    h.enabledSettings = new Set(['EnableStudioCreateV2']);
    renderPage('video');
    expect(screen.getByTestId('create-v2-stub')).toHaveAttribute('data-medium', 'video');
    expect(screen.queryByTestId('studio-tabs')).not.toBeInTheDocument();
  });

  it('shows the legacy tabs when EnableStudioCreateV2 is off', () => {
    renderPage('video');
    expect(screen.getByTestId('studio-tabs')).toBeInTheDocument();
    expect(screen.queryByTestId('create-v2-stub')).not.toBeInTheDocument();
  });

  it('opens the Image medium with Create v2 and EnableStudioImage on', () => {
    h.enabledSettings = new Set(['EnableStudioCreateV2', 'EnableStudioImage']);
    renderPage('image');
    expect(screen.getByTestId('create-v2-stub')).toHaveAttribute('data-medium', 'image');
  });

  it('answers not found for the Image medium while EnableStudioImage is off', () => {
    h.enabledSettings = new Set(['EnableStudioCreateV2']);
    renderPage('image');
    expect(screen.getByTestId('not-found-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('create-v2-stub')).not.toBeInTheDocument();
  });
});

describe('StudioPage for an admin', () => {
  it('follows the same setting', () => {
    h.isAdmin = true;
    h.enabledSettings = new Set(['EnableStudioCreateV2']);
    const { unmount } = renderPage('video');
    expect(screen.getByTestId('create-v2-stub')).toBeInTheDocument();
    unmount();
    h.enabledSettings = new Set();
    renderPage('video');
    expect(screen.getByTestId('studio-tabs')).toBeInTheDocument();
  });
});

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  studioFeatures: {} as Record<string, boolean>,
  productionsAccess: undefined as 'open' | 'upgrade' | 'closed' | undefined,
}));

vi.mock('@tanstack/react-router', async () => {
  const { createLinkStub } = await import('@client/app/components/Studio/testUtils/routerLinkMock');
  return { createLink: createLinkStub };
});
// The header balance reads the live account; StudioCreditsBalance.test.tsx covers it.
vi.mock('./StudioCreditsBalance', () => ({ default: () => null }));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('../useStudioFeature', () => ({
  useStudioFeature: (feature: string) => h.studioFeatures[feature] ?? false,
  useStudioFeatureAccess: (feature: string) =>
    feature === 'productions' && h.productionsAccess
      ? h.productionsAccess
      : h.studioFeatures[feature]
        ? 'open'
        : 'closed',
}));
// The Library's own browser is covered by StudioLibrary.test.tsx; this pins only that the page mounts it.
vi.mock('@client/app/components/Files/StudioLibrary', () => ({
  StudioLibrary: () => <div data-testid="studio-library" />,
}));
// The list's own behavior is covered by ProductionsList.test.tsx; this pins only that the page mounts it.
vi.mock('../productions/ProductionsList', () => ({ default: () => <div data-testid="productions-list" /> }));

import StudioLibraryPage from './StudioLibraryPage';
import StudioProductionsPage from './StudioProductionsPage';
import StudioV2Frame from './StudioV2Frame';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  h.studioFeatures = { createV2: true, productions: true };
  h.productionsAccess = undefined;
});

describe('Studio Productions', () => {
  it('mounts the productions list under the Productions area', () => {
    render(<StudioProductionsPage />, { wrapper: TestWrapper });
    expect(screen.getByTestId('studio-area-productions')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('studio-productions-page')).toContainElement(screen.getByTestId('productions-list'));
  });

  it('links back to Create on the Image medium when it is open, else Video', () => {
    h.studioFeatures = { createV2: true, productions: true, image: true };
    const { unmount } = render(<StudioProductionsPage />, { wrapper: TestWrapper });
    expect(screen.getByTestId('studio-area-create')).toHaveAttribute('href', '/studio/image');
    unmount();
    h.studioFeatures = { createV2: true, productions: true };
    render(<StudioProductionsPage />, { wrapper: TestWrapper });
    expect(screen.getByTestId('studio-area-create')).toHaveAttribute('href', '/studio/video');
  });
});

describe('Studio frame', () => {
  const renderFrame = () =>
    render(
      <StudioV2Frame area="create" testId="studio-frame">
        <div />
      </StudioV2Frame>,
      { wrapper: TestWrapper }
    );

  it.each(['open', 'upgrade'] as const)('shows the Productions tab when access is %s', access => {
    h.productionsAccess = access;
    renderFrame();
    expect(screen.getByTestId('studio-area-productions')).toBeInTheDocument();
  });

  it('hides the Productions tab when access is closed', () => {
    h.productionsAccess = 'closed';
    renderFrame();
    expect(screen.queryByTestId('studio-area-productions')).not.toBeInTheDocument();
  });

  it('keeps the Create link on the current medium while in Create', () => {
    h.studioFeatures = { createV2: true, image: true };
    render(
      <StudioV2Frame area="create" medium="music" testId="studio-frame">
        <div />
      </StudioV2Frame>,
      { wrapper: TestWrapper }
    );
    expect(screen.getByTestId('studio-area-create')).toHaveAttribute('href', '/studio/music');
    expect(screen.getByTestId('studio-area-create')).toHaveAttribute('aria-current', 'page');
  });
});

describe('Studio Library', () => {
  it('mounts the Studio Library under the Library area', () => {
    render(<StudioLibraryPage />, { wrapper: TestWrapper });
    expect(screen.getByTestId('studio-area-library')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('studio-library-page')).toContainElement(screen.getByTestId('studio-library'));
  });
});

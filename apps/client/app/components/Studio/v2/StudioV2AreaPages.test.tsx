import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  studioFeatures: {} as Record<string, boolean>,
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }));
// The header balance reads the live account; StudioCreditsBalance.test.tsx covers it.
vi.mock('./StudioCreditsBalance', () => ({ default: () => null }));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('../useStudioFeature', () => ({
  useStudioFeature: (feature: string) => h.studioFeatures[feature] ?? false,
}));
// The Library's own browser is covered by StudioLibrary.test.tsx; this pins only that the page mounts it.
vi.mock('@client/app/components/Files/StudioLibrary', () => ({
  StudioLibrary: () => <div data-testid="studio-library" />,
}));

import StudioLibraryPage from './StudioLibraryPage';
import StudioProductionsPage from './StudioProductionsPage';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  h.studioFeatures = { createV2: true, productions: true };
});

describe('Studio Productions', () => {
  it('is a coming-soon placeholder under the Productions area', () => {
    render(<StudioProductionsPage />, { wrapper: TestWrapper });
    expect(screen.getByTestId('studio-productions-page')).toBeInTheDocument();
    expect(screen.getByTestId('studio-area-productions')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('studio-productions-coming-soon')).toHaveTextContent('coming soon');
  });

  it('returns to Create on the Image medium when it is open, else Video', () => {
    h.studioFeatures = { createV2: true, productions: true, image: true };
    const { unmount } = render(<StudioProductionsPage />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('studio-area-create'));
    expect(h.navigate).toHaveBeenCalledWith({ to: '/studio/$modality', params: { modality: 'image' } });
    unmount();
    h.studioFeatures = { createV2: true, productions: true };
    render(<StudioProductionsPage />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('studio-area-create'));
    expect(h.navigate).toHaveBeenLastCalledWith({ to: '/studio/$modality', params: { modality: 'video' } });
  });
});

describe('Studio Library', () => {
  it('mounts the Studio Library under the Library area', () => {
    render(<StudioLibraryPage />, { wrapper: TestWrapper });
    expect(screen.getByTestId('studio-area-library')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('studio-library-page')).toContainElement(screen.getByTestId('studio-library'));
  });
});

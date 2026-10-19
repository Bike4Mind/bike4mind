import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { NavigationIntent } from '@bike4mind/common';

const h = vi.hoisted(() => ({ hiddenSurfaces: [] as string[], pathname: '/notebooks/abc' }));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: ({ select }: { select: (l: { pathname: string }) => unknown }) => select({ pathname: h.pathname }),
}));
vi.mock('@client/app/hooks/useHiddenSurfaces', () => ({ useHiddenSurfaceIds: () => h.hiddenSurfaces }));
vi.mock('@client/app/components/admin/useAdminModal', () => ({
  useAdminModal: (selector: (s: unknown) => unknown) => selector({ setActiveTab: vi.fn() }),
}));
vi.mock('@client/app/components/Files/Browser', () => ({
  useFileBrowser: (selector: (s: unknown) => unknown) => selector({ setOpen: vi.fn() }),
}));
vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({ premiumRoutes: [{ path: '/opti' }] }));

import NavigationButtons from './NavigationButtons';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const intents = [
  { viewId: 'opti-family', label: 'Open solver', reason: 'r', navigationType: 'action', target: 'scheduling' },
  { viewId: 'notebooks', label: 'Notebooks', reason: 'r', navigationType: 'route', target: '/notebooks' },
] as NavigationIntent[];

describe('NavigationButtons', () => {
  beforeEach(() => {
    h.hiddenSurfaces = [];
    h.pathname = '/notebooks/abc';
  });

  it('does not render a suggestion into a hidden workspace', () => {
    h.hiddenSurfaces = ['opti'];
    render(<NavigationButtons navigationIntents={intents} />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('nav-btn-opti-family')).toBeNull();
    expect(screen.getByTestId('nav-btn-notebooks')).toBeInTheDocument();
  });

  it('renders nothing when every suggestion leads into a hidden workspace', () => {
    h.hiddenSurfaces = ['opti'];
    const { container } = render(<NavigationButtons navigationIntents={[intents[0]]} />, { wrapper: TestWrapper });
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the suggestion while the user is already in that workspace', () => {
    h.hiddenSurfaces = ['opti'];
    h.pathname = '/opti';
    render(<NavigationButtons navigationIntents={intents} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('nav-btn-opti-family')).toBeInTheDocument();
  });

  it('shows the surface again when unhidden', () => {
    render(<NavigationButtons navigationIntents={intents} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('nav-btn-opti-family')).toBeInTheDocument();
  });
});

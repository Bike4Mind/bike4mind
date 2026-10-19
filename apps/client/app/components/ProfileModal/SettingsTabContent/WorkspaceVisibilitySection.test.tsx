import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { getWorkspaceSurface, OPTI_SURFACE, type WorkspaceSurface } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  workspaces: [] as WorkspaceSurface[],
  hidden: [] as string[],
  setHidden: vi.fn(),
}));

vi.mock('@client/app/hooks/useWorkspaceTargets', () => ({ useHideableWorkspaces: () => h.workspaces }));
vi.mock('@client/app/hooks/useHiddenSurfaces', () => ({
  useHiddenSurfaces: () => ({
    hiddenSurfaces: h.hidden,
    isHidden: (id: string | null) => !!id && h.hidden.includes(id),
    setHidden: h.setHidden,
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import WorkspaceVisibilitySection from './WorkspaceVisibilitySection';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const opti = getWorkspaceSurface(OPTI_SURFACE)!;
const SWITCH_ID = `settings-workspace-visibility-${OPTI_SURFACE}-switch`;
const switchInput = () => screen.getByTestId(SWITCH_ID).querySelector('input')!;

describe('WorkspaceVisibilitySection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.workspaces = [opti];
    h.hidden = [];
  });

  it('renders nothing for a user who cannot use any hideable workspace', () => {
    h.workspaces = [];
    const { container } = render(<WorkspaceVisibilitySection />, { wrapper: TestWrapper });
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId(SWITCH_ID)).toBeNull();
  });

  it('shows the switch on while the workspace is visible, and hides it when turned off', () => {
    render(<WorkspaceVisibilitySection />, { wrapper: TestWrapper });
    expect(screen.getByText(opti.label)).toBeInTheDocument();
    expect(switchInput()).toBeChecked();

    fireEvent.click(switchInput());
    expect(h.setHidden).toHaveBeenCalledWith(OPTI_SURFACE, true);
  });

  it('shows the surface again when switched back on', () => {
    h.hidden = [OPTI_SURFACE];
    render(<WorkspaceVisibilitySection />, { wrapper: TestWrapper });
    expect(switchInput()).not.toBeChecked();

    fireEvent.click(switchInput());
    expect(h.setHidden).toHaveBeenCalledWith(OPTI_SURFACE, false);
  });
});

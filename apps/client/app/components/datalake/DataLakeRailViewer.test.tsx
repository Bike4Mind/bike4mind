import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// The real KnowledgeViewer drags in the websocket/session/artifact chain; what this suite owns
// is the CONTRACT of this mount - the two props that keep a docked-chat host alive.
const captured: Array<Record<string, unknown>> = [];
vi.mock('@client/app/components/Knowledge/KnowledgeViewer', () => ({
  default: (props: Record<string, unknown>) => {
    captured.push(props);
    return <div data-testid="mock-knowledge-viewer" />;
  },
}));

const mockIsMobile = vi.hoisted(() => ({ value: false }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => mockIsMobile.value }));

const mockSetLayout = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/useSessionLayout', () => ({ setSessionLayout: mockSetLayout }));

import DataLakeRailViewer from './DataLakeRailViewer';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('DataLakeRailViewer', () => {
  it('mounts the viewer with both host-protecting props (regression guard)', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <DataLakeRailViewer />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('datalake-rail-viewer')).toBeInTheDocument();
    expect(captured).toHaveLength(1);
    // Load-bearing, both of them: with autoHideOnEmpty the viewer writes layout 'hide' whenever
    // it has nothing to show, and the layout ButtonGroup writes the layout on click - either
    // write collapses the host's docked chat to 0x0 with nothing on-surface to restore it.
    expect(captured[0].autoHideOnEmpty).toBe(false);
    expect(captured[0].showLayoutControls).toBe(false);
  });

  it('stays an inline rail above the phone breakpoint', () => {
    mockIsMobile.value = false;
    render(
      <CssVarsProvider theme={appTheme}>
        <DataLakeRailViewer />
      </CssVarsProvider>
    );
    const el = screen.getByTestId('datalake-rail-viewer');
    expect(el).toHaveAttribute('data-presentation', 'rail');
    expect(getComputedStyle(el).position).not.toBe('fixed');
  });

  it('covers the viewport at phone width instead of sitting beside chat', () => {
    mockIsMobile.value = true;
    render(
      <CssVarsProvider theme={appTheme}>
        <DataLakeRailViewer />
      </CssVarsProvider>
    );
    const el = screen.getByTestId('datalake-rail-viewer');
    expect(el).toHaveAttribute('data-presentation', 'fullscreen');
    const root = el.closest('[role="presentation"]') as HTMLElement;
    expect(getComputedStyle(root).position).toBe('fixed');
    mockIsMobile.value = false;
  });

  it('hosts the phone viewer in a Joy Modal and Escape runs the hide write', () => {
    mockIsMobile.value = true;
    mockSetLayout.mockClear();
    render(
      <CssVarsProvider theme={appTheme}>
        <DataLakeRailViewer />
      </CssVarsProvider>
    );
    const el = screen.getByTestId('datalake-rail-viewer');
    expect(el).toHaveAttribute('role', 'dialog');
    expect(el.closest('[role="presentation"]')).not.toBeNull();
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(mockSetLayout).toHaveBeenCalledWith({ layout: 'hide' });
    mockIsMobile.value = false;
  });
});

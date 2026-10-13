import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ pathname: '/new' }));

vi.mock('@tanstack/react-router', () => ({ useLocation: () => ({ pathname: h.pathname }) }));
vi.mock('./Sidenav', () => ({ default: () => <nav aria-label="Sidebar" data-testid="sidenav-marker" /> }));
vi.mock('./Header', () => ({ default: () => <header data-testid="header-marker" /> }));
vi.mock('../../Knowledge/KnowledgeModal', () => ({ default: () => null }));
vi.mock('../../help', () => ({ HelpPanel: () => null, HelpSuggestionBanner: () => null }));
vi.mock('../../DataLakeWizard/DataLakeUploadIndicator', () => ({ default: () => null }));
vi.mock('../../Session/CollapseButton', () => ({ default: () => null }));
vi.mock('@client/app/hooks/useHelpKeyboardShortcut', () => ({ useHelpKeyboardShortcut: () => undefined }));
vi.mock('@client/app/hooks/useCommandPaletteShortcut', () => ({ useCommandPaletteShortcut: () => undefined }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (select: (s: { impersonating: boolean }) => unknown) => select({ impersonating: false }),
}));
vi.mock('@client/app/hooks/useDataLakeMode', () => ({
  default: (select: (s: { enabled: boolean }) => unknown) => select({ enabled: false }),
}));
vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({ premiumRoutes: [] }));

import NotebookLayout from './index';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderLayout = (children = <p>page body</p>) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <NotebookLayout>{children}</NotebookLayout>
    </CssVarsProvider>
  );

describe('NotebookLayout landmarks', () => {
  beforeEach(() => {
    h.pathname = '/new';
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the sidebar nav and header outside main, as siblings', () => {
    renderLayout();
    const main = screen.getByRole('main');
    expect(within(main).getByText('page body')).toBeTruthy();
    expect(main.contains(screen.getByTestId('sidenav-marker'))).toBe(false);
    expect(main.contains(screen.getByTestId('header-marker'))).toBe(false);
  });

  it('gives a screen without its own heading exactly one h1', () => {
    renderLayout();
    expect(screen.getAllByRole('heading', { level: 1 }).map(el => el.textContent)).toEqual(['New chat']);
  });

  it('adds no h1 to a screen that renders its own', () => {
    h.pathname = '/projects';
    renderLayout(<h1>Projects</h1>);
    expect(screen.getAllByRole('heading', { level: 1 }).map(el => el.textContent)).toEqual(['Projects']);
  });

  it('renders no heading of its own on /projects, where the page supplies its h1', () => {
    h.pathname = '/projects';
    renderLayout();
    expect(screen.queryByTestId('route-heading')).toBeNull();
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(0);
  });

  it('leaves focus on body at first load so keyboard users start at the sidebar', () => {
    renderLayout();
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    expect(document.activeElement).toBe(document.body);
  });

  it('moves focus left on body to the heading after a route change', () => {
    const view = renderLayout();
    h.pathname = '/skills';
    view.rerender(
      <CssVarsProvider theme={appTheme}>
        <NotebookLayout>
          <p>page body</p>
        </NotebookLayout>
      </CssVarsProvider>
    );
    expect(document.activeElement).toBe(document.body);
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('leaves focus alone when the screen already focused a control', () => {
    const view = renderLayout(<input aria-label="composer" autoFocus />);
    h.pathname = '/skills';
    view.rerender(
      <CssVarsProvider theme={appTheme}>
        <NotebookLayout>
          <input aria-label="composer" autoFocus />
        </NotebookLayout>
      </CssVarsProvider>
    );
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    expect(document.activeElement).toBe(screen.getByLabelText('composer'));
  });
});

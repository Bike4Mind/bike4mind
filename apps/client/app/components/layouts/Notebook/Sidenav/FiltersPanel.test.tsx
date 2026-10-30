import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import FiltersPanel from './FiltersPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderPanel = (overrides: Partial<React.ComponentProps<typeof FiltersPanel>> = {}) => {
  const props: React.ComponentProps<typeof FiltersPanel> = {
    typeOptions: [{ value: 'all', label: 'All' }],
    typeFilter: 'all',
    setTypeFilter: vi.fn(),
    contentFilter: 'all',
    setContentFilter: vi.fn(),
    originFilter: 'all',
    setOriginFilter: vi.fn(),
    showMessageCounts: false,
    setShowMessageCounts: vi.fn(),
    onOpenBulkActions: vi.fn(),
    onClose: vi.fn(),
    anchorRef: { current: null },
    ...overrides,
  };
  render(<FiltersPanel {...props} />, { wrapper: TestWrapper });
  return props;
};

const isChecked = (testId: string) =>
  (screen.getByTestId(testId).querySelector('input[type="radio"]') as HTMLInputElement).checked;

const anchorAt = () => {
  const anchor = document.createElement('div');
  anchor.getBoundingClientRect = () => ({
    top: 100,
    bottom: 136,
    left: 294,
    right: 330,
    width: 36,
    height: 36,
    x: 294,
    y: 100,
    toJSON: () => ({}),
  });
  return anchor;
};

describe('FiltersPanel placement', () => {
  const originalWidth = window.innerWidth;
  const setScreen = (width: number) => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  };
  afterEach(() => {
    setScreen(originalWidth);
    vi.restoreAllMocks();
  });

  it('opens on <body>, centred under the button and 8px below it', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(230);
    setScreen(1440);
    renderPanel({ anchorRef: { current: anchorAt() } });
    const panel = screen.getByTestId('sidenav-filters-panel');
    expect(panel.parentElement).toBe(document.body);
    const style = getComputedStyle(panel);
    expect(style.position).toBe('fixed');
    expect(style.top).toBe('144px');
    expect(style.left).toBe('197px');
    expect(style.width).toBe('max-content');
    expect(style.maxWidth).toBe('calc(100vw - 16px)');
    expect(style.maxHeight).toBe('calc(100dvh - 160px)');
  });

  // The sidebar keeps its width on a phone, so a panel centred under the button runs off a 390px screen.
  it('centres it on the screen when it does not fit under the button', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(230);
    setScreen(390);
    renderPanel({ anchorRef: { current: anchorAt() } });
    expect(getComputedStyle(screen.getByTestId('sidenav-filters-panel')).left).toBe('80px');
  });

  it('rounds an odd width to a whole pixel', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(231);
    setScreen(1440);
    renderPanel({ anchorRef: { current: anchorAt() } });
    expect(getComputedStyle(screen.getByTestId('sidenav-filters-panel')).left).toBe('197px');
  });

  it('places it again on a resize or rotation', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(230);
    setScreen(1440);
    renderPanel({ anchorRef: { current: anchorAt() } });
    setScreen(390);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(getComputedStyle(screen.getByTestId('sidenav-filters-panel')).left).toBe('80px');
  });
});

describe('FiltersPanel scroll fade', () => {
  const stubScroll = (el: HTMLElement, scrollTop: number) => {
    Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true });
  };
  const fadeOpacity = () => getComputedStyle(screen.getByTestId('sidenav-filters-more')).opacity;

  it('shows while there is more below and hides at the end', () => {
    renderPanel();
    const scroller = screen.getByTestId('sidenav-filters-scroll');
    expect(fadeOpacity()).toBe('0');
    stubScroll(scroller, 0);
    fireEvent.scroll(scroller);
    expect(fadeOpacity()).toBe('1');
    stubScroll(scroller, 200);
    fireEvent.scroll(scroller);
    expect(fadeOpacity()).toBe('0');
  });
});

describe('FiltersPanel keyboard and focus', () => {
  it('closes on Escape', () => {
    const props = renderPanel();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('takes focus on open and hands it back to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    renderPanel();
    expect(document.activeElement).toBe(screen.getByTestId('sidenav-filters-panel'));
    cleanup();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('FiltersPanel content and origin sections', () => {
  it('renders every option and checks the current choices', () => {
    renderPanel({ contentFilter: 'images', originFilter: 'hideApi' });
    for (const id of [
      'sidenav-filter-content-all',
      'sidenav-filter-content-chats',
      'sidenav-filter-content-images',
      'sidenav-filter-origin-all',
      'sidenav-filter-origin-hide-api',
      'sidenav-filter-origin-api',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(isChecked('sidenav-filter-content-images')).toBe(true);
    expect(isChecked('sidenav-filter-content-all')).toBe(false);
    expect(isChecked('sidenav-filter-origin-hide-api')).toBe(true);
  });

  it('reports a content choice', () => {
    const props = renderPanel();
    fireEvent.click(screen.getByTestId('sidenav-filter-content-chats'));
    expect(props.setContentFilter).toHaveBeenCalledWith('chats');
  });

  it('reports an origin choice', () => {
    const props = renderPanel();
    fireEvent.click(screen.getByTestId('sidenav-filter-origin-api'));
    expect(props.setOriginFilter).toHaveBeenCalledWith('onlyApi');
  });

  it('keeps the visibility radios working', () => {
    const props = renderPanel();
    fireEvent.click(screen.getByTestId('sidenav-filter-all'));
    expect(props.setTypeFilter).toHaveBeenCalledWith('all');
  });
});

import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { vi, describe, it, expect } from 'vitest';
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

describe('FiltersPanel placement', () => {
  // The sidebar's scroll region clipped the panel and stretched it to the sidebar's width; it now
  // portals to <body> and sits centred under the Filters button, only as wide as its rows.
  it('opens on <body>, centred under the button and 8px below it', () => {
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
    renderPanel({ anchorRef: { current: anchor } });
    const panel = screen.getByTestId('sidenav-filters-panel');
    expect(panel.parentElement).toBe(document.body);
    const style = getComputedStyle(panel);
    expect(style.position).toBe('fixed');
    expect(style.top).toBe('144px');
    expect(style.left).toBe('312px');
    expect(style.transform).toBe('translateX(-50%)');
    expect(style.width).toBe('max-content');
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

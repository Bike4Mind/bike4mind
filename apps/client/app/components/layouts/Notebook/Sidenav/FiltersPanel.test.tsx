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
    ...overrides,
  };
  render(<FiltersPanel {...props} />, { wrapper: TestWrapper });
  return props;
};

const isChecked = (testId: string) =>
  (screen.getByTestId(testId).querySelector('input[type="radio"]') as HTMLInputElement).checked;

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

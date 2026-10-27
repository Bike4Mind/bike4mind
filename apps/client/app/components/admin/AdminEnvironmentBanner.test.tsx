import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sheet } from '@mui/joy';
import AppTheme from '@client/app/utils/themes/AppTheme';
import EnvironmentBanner from './AdminEnvironmentBanner';

vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ history: { back: vi.fn() } }) }));
vi.mock('@client/app/hooks/useHelpPanel', () => ({ openHelpPanel: vi.fn() }));

const PROPS = ['color', 'background-color', 'font-size', 'font-family', 'border-color'] as const;

const renderBanner = (withAdminSurface: boolean) => {
  const { unmount } = render(
    <AppTheme>
      <EnvironmentBanner />
      {withAdminSurface && <Sheet data-admin-surface />}
    </AppTheme>
  );
  const elements = [
    screen.getByText(/./, { selector: 'p' }),
    screen.getByTestId('admin-help-center-btn'),
    screen.getByTestId('close-admin-page-banner-btn').closest('button') as HTMLElement,
  ];
  const styles = elements.map(element => PROPS.map(prop => getComputedStyle(element).getPropertyValue(prop)));
  unmount();
  return styles;
};

describe('AdminEnvironmentBanner', () => {
  // The admin page mounts the banner beside its `data-admin-surface` root, never inside it.
  it('renders the same whether or not an admin surface is mounted', () => {
    expect(renderBanner(true)).toEqual(renderBanner(false));
  });

  it('keeps its title and buttons white', () => {
    const [title, help, close] = renderBanner(true);
    expect([title[0], help[0], close[0]]).toEqual(['rgb(255, 255, 255)', 'rgb(255, 255, 255)', 'rgb(255, 255, 255)']);
  });
});

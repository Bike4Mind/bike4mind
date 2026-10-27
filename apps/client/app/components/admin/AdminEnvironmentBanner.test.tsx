import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Sheet } from '@mui/joy';
import AppTheme from '@client/app/utils/themes/AppTheme';
import EnvironmentBanner from './AdminEnvironmentBanner';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
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
    screen.getByTestId('environment-banner-title'),
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

  it('keeps its title and buttons in the banner foreground', () => {
    const [title, help, close] = renderBanner(true);
    expect([title[0], help[0], close[0]]).toEqual(['rgb(244, 244, 245)', 'rgb(244, 244, 245)', 'rgb(244, 244, 245)']);
  });

  it('is a 24 px strip with a 12/500 label on the local fill', () => {
    render(
      <AppTheme>
        <EnvironmentBanner />
      </AppTheme>
    );
    const strip = getComputedStyle(screen.getByTestId('environment-banner'));
    const title = getComputedStyle(screen.getByTestId('environment-banner-title'));
    expect([strip.height, strip.backgroundColor]).toEqual(['24px', 'rgb(47, 94, 72)']);
    expect([title.fontSize, title.fontWeight]).toEqual(['12px', '500']);
  });

  // Admin pages push history entries, so a history step would usually land on another admin page.
  it('leaves admin for the home page instead of stepping back through history', () => {
    render(
      <AppTheme>
        <EnvironmentBanner />
      </AppTheme>
    );
    fireEvent.click(screen.getByTestId('close-admin-page-banner-btn'));
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
  });
});

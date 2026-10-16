import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { navigateMock, openExternalLinkByKeyMock, h } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  openExternalLinkByKeyMock: vi.fn(),
  h: { optiVisible: false },
}));

vi.mock('@client/app/hooks/data/opti', () => ({ useOptiVisible: () => h.optiVisible }));
vi.mock('@client/app/utils/externalLinks', () => ({ openExternalLinkByKey: openExternalLinkByKeyMock }));
vi.mock('@client/app/contexts/ModalTriggerContext', () => ({
  useModalTrigger: () => ({ triggerModalByTag: vi.fn() }),
}));
vi.mock('@client/app/hooks/useAppVersion', () => ({ useAppVersion: () => ({ data: { version: '1.0.0' } }) }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsTablet: () => false }));
vi.mock('@client/app/hooks/useGetLogo', () => ({ default: () => '/logo.png' }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateMock }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('..', () => ({
  useNotebookLayout: (selector: (s: { openSideNav: boolean; setOpenSideNav: () => void }) => unknown) =>
    selector({ openSideNav: true, setOpenSideNav: vi.fn() }),
}));

import SideNavHeader from './Header';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderHeader = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SideNavHeader />
    </CssVarsProvider>
  );

describe('SideNavHeader logo target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.optiVisible = false;
  });

  it('opens the workspace when it is visible to the user', () => {
    h.optiVisible = true;
    renderHeader();
    fireEvent.click(screen.getByTestId('sidenav-header-logo'));
    expect(navigateMock).toHaveBeenCalledWith({ to: '/opti' });
    expect(openExternalLinkByKeyMock).not.toHaveBeenCalled();
  });

  it('opens the website instead when the workspace is hidden or not available', () => {
    renderHeader();
    fireEvent.click(screen.getByTestId('sidenav-header-logo'));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(openExternalLinkByKeyMock).toHaveBeenCalledWith('website');
  });
});

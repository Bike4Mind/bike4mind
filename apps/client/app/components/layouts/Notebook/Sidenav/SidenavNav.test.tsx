import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * The two gates on the Hearth nav row, which had no test at all.
 *
 * The row is DOUBLE gated and the two halves fail in OPPOSITE directions on
 * purpose, which is the part worth pinning: the experimental flag fails closed
 * (no flag, no row), and so does the gear - unlike the pre-Gears rows beside it,
 * where an unknown gear state must not remove navigation the user already had.
 */
const { useFeatureEnabledMock, useGearUnlocksMock } = vi.hoisted(() => ({
  useFeatureEnabledMock: vi.fn(),
  useGearUnlocksMock: vi.fn(),
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: useFeatureEnabledMock }),
}));
vi.mock('@client/app/hooks/useGearsStatus', () => ({ useGearUnlocks: useGearUnlocksMock }));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => undefined }));
vi.mock('@client/app/hooks/data/opti', () => ({ useOptiAccess: () => false }));
// Mocked for the same reason as the line above: the real hook calls `useEntitlements`, which is a
// react-query `useQuery`, and this suite renders without a QueryClientProvider.
vi.mock('@client/app/hooks/data/meetings', () => ({ useMeetingsAccess: () => false }));
vi.mock('@client/app/components/Files/Browser', () => ({
  useFileBrowser: () => ({ open: false, setOpen: vi.fn() }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/hooks/useHelpPanel', () => ({
  useHelpPanel: () => false,
  openHelpPanel: vi.fn(),
}));
vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({ premiumRoutes: [] }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/new', search: {} }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));
vi.mock('..', () => ({ useNotebookLayout: () => vi.fn() }));

import SidenavNav from './SidenavNav';

const appTheme = extendTheme({ ...getThemeConfig() });

function renderNav() {
  return render(
    <CssVarsProvider theme={appTheme}>
      <SidenavNav />
    </CssVarsProvider>
  );
}

const hearthRow = () => screen.queryByTestId('sidenav-nav-hearth');

beforeEach(() => {
  vi.clearAllMocks();
  useFeatureEnabledMock.mockImplementation((key: string) => key === 'enableHearth');
  useGearUnlocksMock.mockReturnValue({ hearth: true });
});

describe('SidenavNav Hearth row', () => {
  it('shows when the flag is on and the gear is earned', () => {
    renderNav();
    expect(hearthRow()).toBeInTheDocument();
  });

  it('hides when the experimental flag is off, even with the gear earned', () => {
    useFeatureEnabledMock.mockReturnValue(false);
    renderNav();
    expect(hearthRow()).not.toBeInTheDocument();
  });

  it('hides when the gear is explicitly unearned', () => {
    useGearUnlocksMock.mockReturnValue({ hearth: false });
    renderNav();
    expect(hearthRow()).not.toBeInTheDocument();
  });

  // The three cases below are the fail-CLOSED direction, and all three used to
  // REVEAL the row. `gearOpen` treats an unknown gear state as open so that a
  // loading state or a renamed key cannot delete navigation that predates Gears;
  // Hearth is net-new, so there is nothing to preserve and the reasoning inverts.
  it('hides while the gear status is still loading', () => {
    useGearUnlocksMock.mockReturnValue(undefined);
    renderNav();
    expect(hearthRow()).not.toBeInTheDocument();
  });

  it('hides when an admin disables the gear, which drops the key from the response', () => {
    // /api/gears/status omits admin-disabled gears entirely rather than
    // returning them as false, so "key absent" is the shape a disabled gear
    // actually takes - and under gearOpen that made disabling it reveal the row
    // permanently to every flag-enabled user.
    useGearUnlocksMock.mockReturnValue({ projects: true });
    renderNav();
    expect(hearthRow()).not.toBeInTheDocument();
  });

  it('hides when the gear status errors', () => {
    useGearUnlocksMock.mockReturnValue({});
    renderNav();
    expect(hearthRow()).not.toBeInTheDocument();
  });

  // Guards the boundary between the two helpers: switching Hearth to fail-closed
  // must not drag the pre-Gears rows along with it.
  it('still shows a pre-Gears row whose gear key is absent', () => {
    useFeatureEnabledMock.mockReturnValue(true);
    useGearUnlocksMock.mockReturnValue({});
    renderNav();
    expect(screen.getByTestId('sidenav-nav-files')).toBeInTheDocument();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * What gates the feature rows in the sidenav.
 *
 * Gears used to gate them, and no longer does: a feature's row is always there,
 * whether or not its gear is earned. That is the part worth pinning, because the
 * old behaviour was a discovery trap - Hearth's only entry point was the Gears
 * page, so its row could never appear on its own. Feature FLAGS still gate, and
 * still fail closed.
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
// SidenavNav gates the Bob row on entitlements via useEntitlements (react-query useQuery).
// This suite renders SidenavNav without a QueryClientProvider, so stub the hook like the
// others rather than mount a client - the Bob gate is not what these Hearth tests exercise.
vi.mock('@client/app/hooks/data/entitlements', () => ({ useEntitlements: () => ({ data: [] }) }));
// The meetings row is gated the same way, through a hook that wraps useEntitlements, so it needs
// its own stub rather than riding on the one above.
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

/** Every gear state the status endpoint can produce, including its failure shapes. */
const GEAR_STATES: [string, Record<string, boolean> | undefined][] = [
  ['earned', { hearth: true, files: true, projects: true, published: true, agents: true }],
  ['explicitly unearned', { hearth: false, files: false, projects: false, published: false, agents: false }],
  ['still loading', undefined],
  // An admin-disabled gear is omitted from the response entirely rather than
  // returned as false, so "key absent" is a shape that really occurs.
  ['admin-disabled (key absent)', { projects: true }],
  ['errored (empty)', {}],
];

beforeEach(() => {
  vi.clearAllMocks();
  useFeatureEnabledMock.mockImplementation((key: string) => key === 'enableHearth');
  useGearUnlocksMock.mockReturnValue({ hearth: true });
});

describe('SidenavNav feature rows', () => {
  describe.each(GEAR_STATES)('with gears %s', (_label, unlocks) => {
    it('still shows every feature row', () => {
      useFeatureEnabledMock.mockReturnValue(true);
      useGearUnlocksMock.mockReturnValue(unlocks);
      renderNav();

      for (const key of ['files', 'projects', 'published', 'agents', 'hearth']) {
        expect(screen.getByTestId(`sidenav-nav-${key}`)).toBeInTheDocument();
      }
    });
  });
});

describe('SidenavNav Hearth row', () => {
  it('shows when the experimental flag is on', () => {
    renderNav();
    expect(hearthRow()).toBeInTheDocument();
  });

  it('hides when the experimental flag is off', () => {
    useFeatureEnabledMock.mockReturnValue(false);
    renderNav();
    expect(hearthRow()).not.toBeInTheDocument();
  });

  // The flag is the only gate left, so an unearned gear must NOT remove the row -
  // this is the case that inverted, and the reason the change exists.
  it('shows with the flag on even though the gear is unearned', () => {
    useGearUnlocksMock.mockReturnValue({ hearth: false });
    renderNav();
    expect(hearthRow()).toBeInTheDocument();
  });
});

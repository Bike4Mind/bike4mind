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
const { useFeatureEnabledMock, useGearsNavSignalMock } = vi.hoisted(() => ({
  useFeatureEnabledMock: vi.fn(),
  useGearsNavSignalMock: vi.fn(),
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: useFeatureEnabledMock }),
}));
vi.mock('@client/app/hooks/useVisibleGears', () => ({ useGearsNavSignal: useGearsNavSignalMock }));
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
  useTranslation: () => ({
    t: (key: string, fallback?: string, options?: { count?: number }) => {
      const value = fallback ?? key;
      return options?.count === undefined ? value : value.replace('{{count}}', String(options.count));
    },
  }),
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
  useGearsNavSignalMock.mockReturnValue({ startHere: false, claimableCount: 0 });
});

describe('SidenavNav feature rows', () => {
  // SidenavNav reads no gear unlock state at all any more; only flags gate a row.
  it('shows every feature row with its flag on', () => {
    useFeatureEnabledMock.mockReturnValue(true);
    renderNav();

    for (const key of ['files', 'projects', 'published', 'agents', 'hearth']) {
      expect(screen.getByTestId(`sidenav-nav-${key}`)).toBeInTheDocument();
    }
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
});

describe('SidenavNav Gears row tag', () => {
  const startHere = () => screen.queryByTestId('sidenav-gears-start-here');
  const rewards = () => screen.queryByTestId('sidenav-gears-rewards');

  it('shows no tag while there is nothing to flag', () => {
    renderNav();
    expect(startHere()).not.toBeInTheDocument();
    expect(rewards()).not.toBeInTheDocument();
  });

  it('says Start here while Getting Started is unfinished', () => {
    useGearsNavSignalMock.mockReturnValue({ startHere: true, claimableCount: 0 });
    renderNav();
    expect(startHere()).toHaveTextContent('Start here');
  });

  it('counts the rewards waiting', () => {
    useGearsNavSignalMock.mockReturnValue({ startHere: false, claimableCount: 3 });
    renderNav();
    expect(rewards()).toHaveTextContent('Claim 3');
  });

  it('a waiting reward replaces Start here rather than sitting beside it', () => {
    useGearsNavSignalMock.mockReturnValue({ startHere: true, claimableCount: 2 });
    renderNav();
    expect(rewards()).toBeInTheDocument();
    expect(startHere()).not.toBeInTheDocument();
  });
});

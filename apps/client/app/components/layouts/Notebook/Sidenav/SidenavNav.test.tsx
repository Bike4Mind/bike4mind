import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
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
const { useFeatureEnabledMock, useGearsNavSignalMock, useVideoModelsMock, navItems, entitlements } = vi.hoisted(() => ({
  useFeatureEnabledMock: vi.fn(),
  useGearsNavSignalMock: vi.fn(),
  useVideoModelsMock: vi.fn(),
  // Mutable so a test can stand in for an overlay's nav contribution; empty is the open-core build.
  navItems: [] as Array<{
    path: string;
    label: string;
    icon?: ComponentType;
    requireEntitlement?: string;
    sidebar?: boolean;
  }>,
  entitlements: [] as string[],
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: useFeatureEnabledMock }),
}));
vi.mock('@client/app/hooks/useVisibleGears', () => ({ useGearsNavSignal: useGearsNavSignalMock }));
// The row is gated on GET /api/v1/video-models (react-query); stubbed like the other data hooks here.
vi.mock('@client/app/hooks/data/videoGenerations', () => ({ useVideoModels: useVideoModelsMock }));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => undefined }));
vi.mock('@client/app/hooks/data/opti', () => ({ useOptiAccess: () => false }));
// SidenavNav gates the Bob row on entitlements via useEntitlements (react-query useQuery).
// This suite renders SidenavNav without a QueryClientProvider, so stub the hook like the
// others rather than mount a client; the Bob row tests set what the user holds.
vi.mock('@client/app/hooks/data/entitlements', () => ({ useEntitlements: () => ({ data: entitlements }) }));
// The meetings row is gated the same way, through a hook that wraps useEntitlements, so it needs
// its own stub rather than riding on the one above.
vi.mock('@client/app/hooks/data/meetings', () => ({ useMeetingsAccess: () => false }));
vi.mock('@client/app/components/Files/Browser', () => ({
  useFileBrowser: () => ({ open: false, setOpen: vi.fn() }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({ premiumRoutes: [] }));
vi.mock('@client/app/premium-generated/premiumNavItems.generated', () => ({ premiumNavItems: navItems }));
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
  useVideoModelsMock.mockReturnValue({ data: [] });
  navItems.length = 0;
  entitlements.length = 0;
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

describe('SidenavNav Video Studio row', () => {
  const videoRow = () => screen.queryByTestId('sidenav-nav-video-studio');

  it('shows when at least one video model is usable', () => {
    useVideoModelsMock.mockReturnValue({ data: [{ id: 'grok-imagine-video-1.5' }] });
    renderNav();
    expect(videoRow()).toHaveTextContent('Video Studio');
  });

  it('hides when no model is usable or the models have not loaded', () => {
    renderNav();
    expect(videoRow()).not.toBeInTheDocument();
    useVideoModelsMock.mockReturnValue({ data: undefined });
    renderNav();
    expect(videoRow()).not.toBeInTheDocument();
  });
});

describe('SidenavNav Bob row', () => {
  const bobRow = () => screen.queryByTestId('sidenav-nav-bob');

  it('hides when no overlay contributes the /bob nav item', () => {
    renderNav();
    expect(bobRow()).not.toBeInTheDocument();
  });

  it('uses the icon the overlay contributes with its nav item', () => {
    navItems.push({ path: '/bob', label: 'Bob', icon: () => <svg data-testid="contributed-nav-icon" /> });
    renderNav();
    expect(bobRow()).toContainElement(screen.getByTestId('contributed-nav-icon'));
    expect(screen.queryByTestId('Diversity3OutlinedIcon')).not.toBeInTheDocument();
  });

  it('stays hidden when the nav item is gated on an entitlement the user lacks, and shows once they hold it', () => {
    navItems.push({ path: '/bob', label: 'Bob', requireEntitlement: 'test-entitlement' });
    renderNav();
    expect(bobRow()).not.toBeInTheDocument();

    entitlements.push('test-entitlement');
    renderNav();
    expect(bobRow()).toBeInTheDocument();
  });

  it('falls back to the stock icon when the nav item has none', () => {
    navItems.push({ path: '/bob', label: 'Bob' });
    renderNav();
    expect(bobRow()).toContainElement(screen.getByTestId('Diversity3OutlinedIcon'));
  });
});

describe('SidenavNav overlay-contributed sidebar rows', () => {
  const contributedRow = () => screen.queryByTestId('sidenav-nav-premium-launch');

  it('draws no row when no overlay contributes one (open-core build)', () => {
    renderNav();
    expect(screen.queryByTestId(/^sidenav-nav-premium-/)).not.toBeInTheDocument();
  });

  it('draws a nav item that opts into the sidebar, with its label and gate', () => {
    navItems.push({ path: '/launch', label: 'Launch Pad', requireEntitlement: 'launch:pro', sidebar: true });
    renderNav();
    expect(contributedRow()).not.toBeInTheDocument();

    entitlements.push('launch:pro');
    renderNav();
    expect(contributedRow()).toHaveTextContent('Launch Pad');
  });

  it('leaves a nav item that does not opt in to the More flyout', () => {
    navItems.push({ path: '/launch', label: 'Launch Pad' });
    renderNav();
    expect(contributedRow()).not.toBeInTheDocument();
  });

  it('uses the contributed icon, falling back to a stock glyph', () => {
    navItems.push({ path: '/launch', label: 'Launch Pad', sidebar: true });
    renderNav();
    expect(contributedRow()).toContainElement(screen.getByTestId('ExtensionOutlinedIcon'));

    navItems.length = 0;
    navItems.push({
      path: '/launch',
      label: 'Launch Pad',
      sidebar: true,
      icon: () => <svg data-testid="contributed-sidebar-icon" />,
    });
    renderNav();
    expect(screen.getAllByTestId('sidenav-nav-premium-launch').at(-1)).toContainElement(
      screen.getByTestId('contributed-sidebar-icon')
    );
  });

  it('does not draw Bob twice when its nav item opts in too', () => {
    navItems.push({ path: '/bob', label: 'Bob', sidebar: true });
    renderNav();
    expect(screen.getAllByTestId('sidenav-nav-bob')).toHaveLength(1);
    expect(screen.queryByTestId('sidenav-nav-premium-bob')).not.toBeInTheDocument();
  });
});

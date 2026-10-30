import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import type { ComponentType } from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { settingsMap } from '@bike4mind/common';

/**
 * What gates the feature rows in the sidenav.
 *
 * Gears used to gate them, and no longer does: a feature's row is always there,
 * whether or not its gear is earned. That is the part worth pinning, because the
 * old behaviour was a discovery trap - Hearth's only entry point was the Gears
 * page, so its row could never appear on its own. Feature FLAGS still gate, and
 * still fail closed.
 */
const {
  useFeatureEnabledMock,
  useGearsNavSignalMock,
  useVideoModelsMock,
  useMusicModelsMock,
  useAudioProvidersMock,
  navigate,
  location,
  navItems,
  entitlements,
  userState,
  logEvent,
} = vi.hoisted(() => ({
  useFeatureEnabledMock: vi.fn(),
  useGearsNavSignalMock: vi.fn(),
  useVideoModelsMock: vi.fn(),
  useMusicModelsMock: vi.fn(),
  useAudioProvidersMock: vi.fn(),
  navigate: vi.fn(),
  location: { pathname: '/new' },
  // Mutable so a test can stand in for an overlay's nav contribution; empty is the open-core build.
  navItems: [] as Array<{
    path: string;
    label: string;
    icon?: ComponentType;
    requireEntitlement?: string;
    sidebar?: boolean;
    useSidebarTag?: () => string | null;
  }>,
  entitlements: [] as string[],
  // The real useOptiAccess/useOptiVisible read this store, so the Opti row tests exercise both.
  userState: {
    isAdmin: false,
    currentUser: undefined as { id?: string; preferences?: { hiddenSurfaces?: string[] } } | undefined,
  },
  logEvent: vi.fn(),
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: useFeatureEnabledMock }),
}));
vi.mock('@client/app/hooks/useVisibleGears', () => ({ useGearsNavSignal: useGearsNavSignalMock }));
// The Studio row is gated on GET /api/v1/video-models, /music-models and /api/ai/audio-providers (react-query);
// stubbed like the other data hooks here.
vi.mock('@client/app/hooks/data/videoGenerations', () => ({ useVideoModels: useVideoModelsMock }));
vi.mock('@client/app/hooks/data/musicGenerations', () => ({ useMusicModels: useMusicModelsMock }));
vi.mock('@client/app/hooks/data/audioProviders', () => ({ useAudioProviders: useAudioProvidersMock }));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: logEvent }) }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (state: typeof userState) => unknown) => selector(userState),
}));
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
// Only /opti is mounted, so the Opti row is the one premium row that access can reveal here.
vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({ premiumRoutes: [{ path: '/opti' }] }));
vi.mock('@client/app/premium-generated/premiumNavItems.generated', () => ({ premiumNavItems: navItems }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: location.pathname, search: {} }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>, maybeOptions?: Record<string, unknown>) => {
      const options = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : maybeOptions;
      const plural = options?.count === undefined ? undefined : options.count === 1 ? 'one' : 'other';
      const fallback =
        typeof fallbackOrOptions === 'string'
          ? fallbackOrOptions
          : ((plural && options?.[`defaultValue_${plural}`]) ?? options?.defaultValue);
      return String(fallback ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name]));
    },
    i18n: { language: 'en' },
  }),
}));
vi.mock('..', () => ({ useNotebookLayout: () => vi.fn() }));

import SidenavNav from './SidenavNav';

const appTheme = extendTheme({ ...getThemeConfig() });

function renderNav(section?: 'pinned' | 'scroll' | 'all') {
  return render(
    <CssVarsProvider theme={appTheme}>
      <SidenavNav section={section} />
    </CssVarsProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useFeatureEnabledMock.mockReturnValue(false);
  useGearsNavSignalMock.mockReturnValue({ startHere: false, startHereCredits: 0, claimableCount: 0 });
  useVideoModelsMock.mockReturnValue({ data: [] });
  useMusicModelsMock.mockReturnValue({ data: [] });
  useAudioProvidersMock.mockReturnValue({ data: { speech: [], soundEffects: [] } });
  location.pathname = '/new';
  navItems.length = 0;
  entitlements.length = 0;
  userState.isAdmin = false;
  userState.currentUser = undefined;
  localStorage.clear();
});

describe('SidenavNav Opti row', () => {
  const optiRow = () => screen.queryByTestId('sidenav-nav-opti');

  it('hides without access', () => {
    renderNav();
    expect(optiRow()).not.toBeInTheDocument();
  });

  it('shows with access when the workspace is not hidden', () => {
    userState.isAdmin = true;
    userState.currentUser = { preferences: { hiddenSurfaces: [] } };
    renderNav();
    expect(optiRow()).toBeInTheDocument();
  });

  it('hides with access when the user hid the workspace', () => {
    userState.isAdmin = true;
    userState.currentUser = { preferences: { hiddenSurfaces: ['opti'] } };
    renderNav();
    expect(optiRow()).not.toBeInTheDocument();
  });

  it('shows the workspace again when unhidden', () => {
    userState.isAdmin = true;
    userState.currentUser = { preferences: { hiddenSurfaces: ['opti'] } };
    const { rerender } = renderNav();
    expect(optiRow()).not.toBeInTheDocument();
    userState.currentUser = { preferences: { hiddenSurfaces: [] } };
    rerender(
      <CssVarsProvider theme={appTheme}>
        <SidenavNav />
      </CssVarsProvider>
    );
    expect(optiRow()).toBeInTheDocument();
  });
});

describe('SidenavNav feature rows', () => {
  // SidenavNav reads no gear unlock state at all any more; only flags gate a row.
  it('shows every feature row with its flag on', () => {
    useFeatureEnabledMock.mockReturnValue(true);
    renderNav();

    for (const key of ['files', 'projects', 'published', 'skill-market', 'agents']) {
      expect(screen.getByTestId(`sidenav-nav-${key}`)).toBeInTheDocument();
    }
  });
});

describe('SidenavNav Skill Market row', () => {
  it('is always present and opens the market', () => {
    useFeatureEnabledMock.mockReturnValue(false);
    renderNav();
    const row = screen.getByTestId('sidenav-nav-skill-market');
    expect(row).toHaveTextContent('Skill Market');
    fireEvent.click(row);
    expect(navigate).toHaveBeenCalledWith({ to: '/skills/market' });
  });
});

describe('SidenavNav Hearth row', () => {
  // Hearth lives in the profile menu's More flyout, not the top of the sidenav.
  it('is not in the sidenav even with its flag on', () => {
    useFeatureEnabledMock.mockReturnValue(true);
    renderNav();
    expect(screen.queryByTestId('sidenav-nav-hearth')).not.toBeInTheDocument();
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

  it('says Start here, with the credits on offer, while Getting Started is unfinished', () => {
    useGearsNavSignalMock.mockReturnValue({ startHere: true, startHereCredits: 6500, claimableCount: 0 });
    renderNav();
    expect(startHere()).toHaveTextContent(`Start here, +${(6500).toLocaleString('en')} credits`);
    expect(logEvent).toHaveBeenCalledWith({ type: 'start_here_chip_shown' });
    fireEvent.click(screen.getByTestId('sidenav-nav-gears'));
    expect(logEvent).toHaveBeenCalledWith({ type: 'start_here_chip_clicked' });
  });

  it('logs Start here once per user, not again when the sidenav remounts', () => {
    userState.currentUser = { id: 'user-1' };
    useGearsNavSignalMock.mockReturnValue({ startHere: true, startHereCredits: 6500, claimableCount: 0 });
    renderNav().unmount();
    logEvent.mockClear();
    renderNav();
    expect(startHere()).toBeInTheDocument();
    expect(logEvent).not.toHaveBeenCalledWith({ type: 'start_here_chip_shown' });
  });

  it('does not log Start here from the pinned nav instance that does not render Gears', () => {
    useGearsNavSignalMock.mockReturnValue({ startHere: true, startHereCredits: 6500, claimableCount: 0 });
    renderNav('pinned');
    expect(logEvent).not.toHaveBeenCalledWith({ type: 'start_here_chip_shown' });
  });

  it('says credit, not credits, for a single one', () => {
    useGearsNavSignalMock.mockReturnValue({ startHere: true, startHereCredits: 1, claimableCount: 0 });
    renderNav();
    expect(startHere()).toHaveTextContent(/^Start here, \+1 credit$/);
  });

  it('falls back to a bare Start here when the gears left pay nothing', () => {
    useGearsNavSignalMock.mockReturnValue({ startHere: true, startHereCredits: 0, claimableCount: 0 });
    renderNav();
    expect(startHere()).toHaveTextContent(/^Start here$/);
  });

  it('counts the rewards waiting', () => {
    useGearsNavSignalMock.mockReturnValue({ startHere: false, startHereCredits: 0, claimableCount: 3 });
    renderNav();
    expect(rewards()).toHaveTextContent('Claim 3');
  });

  it('a waiting reward replaces Start here rather than sitting beside it', () => {
    useGearsNavSignalMock.mockReturnValue({ startHere: true, startHereCredits: 6500, claimableCount: 2 });
    renderNav();
    expect(rewards()).toBeInTheDocument();
    expect(startHere()).not.toBeInTheDocument();
  });
});

describe('SidenavNav Studio row', () => {
  const studioRow = () => screen.queryByTestId('sidenav-nav-studio');
  const usable = { data: [{ id: 'some-model' }] };

  it('is one Studio row, shown when a video model is usable', () => {
    useVideoModelsMock.mockReturnValue(usable);
    renderNav();
    expect(screen.getAllByTestId('sidenav-nav-studio')).toHaveLength(1);
    expect(studioRow()).toHaveTextContent('Studio');
  });

  it('hides when no modality has a usable model or the models have not loaded', () => {
    renderNav();
    expect(studioRow()).not.toBeInTheDocument();
    useVideoModelsMock.mockReturnValue({ data: undefined });
    useMusicModelsMock.mockReturnValue({ data: undefined });
    useAudioProvidersMock.mockReturnValue({ data: undefined });
    renderNav();
    expect(studioRow()).not.toBeInTheDocument();
  });

  it('shows with only a speech provider usable, and opens on the speech tab', () => {
    useAudioProvidersMock.mockReturnValue({ data: { speech: ['openai'], soundEffects: [] } });
    renderNav();
    fireEvent.click(screen.getByTestId('sidenav-nav-studio'));
    expect(navigate).toHaveBeenCalledWith({ to: '/studio/$modality', params: { modality: 'speech' } });
  });

  it('opens on the sound effects tab when only a sound-effect provider is usable', () => {
    useAudioProvidersMock.mockReturnValue({ data: { speech: [], soundEffects: ['elevenlabs'] } });
    renderNav();
    fireEvent.click(screen.getByTestId('sidenav-nav-studio'));
    expect(navigate).toHaveBeenCalledWith({ to: '/studio/$modality', params: { modality: 'sound-effects' } });
  });

  it('waits for the audio providers before deciding which tab to open', () => {
    useAudioProvidersMock.mockReturnValue({ data: undefined, isPending: true });
    useMusicModelsMock.mockReturnValue(usable);
    renderNav();
    expect(studioRow()).not.toBeInTheDocument();
  });

  it('opens on the video tab when video is usable', () => {
    useVideoModelsMock.mockReturnValue(usable);
    useMusicModelsMock.mockReturnValue(usable);
    renderNav();
    fireEvent.click(screen.getByTestId('sidenav-nav-studio'));
    expect(navigate).toHaveBeenCalledWith({ to: '/studio/$modality', params: { modality: 'video' } });
  });

  it('shows with only music usable, and opens on the music tab', () => {
    useMusicModelsMock.mockReturnValue(usable);
    renderNav();
    fireEvent.click(screen.getByTestId('sidenav-nav-studio'));
    expect(navigate).toHaveBeenCalledWith({ to: '/studio/$modality', params: { modality: 'music' } });
  });

  it('waits for both model lists before deciding which tab to open', () => {
    useVideoModelsMock.mockReturnValue({ data: undefined, isPending: true });
    useMusicModelsMock.mockReturnValue(usable);
    renderNav();
    expect(studioRow()).not.toBeInTheDocument();
  });

  it('stays reachable through the other modality when one model list errors', () => {
    useVideoModelsMock.mockReturnValue({ data: undefined, isPending: false, isError: true });
    useMusicModelsMock.mockReturnValue(usable);
    renderNav();
    expect(studioRow()).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sidenav-nav-studio'));
    expect(navigate).toHaveBeenCalledWith({ to: '/studio/$modality', params: { modality: 'music' } });
  });

  it('is active on any Studio tab', () => {
    useMusicModelsMock.mockReturnValue(usable);
    location.pathname = '/studio/music';
    renderNav();
    expect(studioRow()).toHaveAttribute('aria-current', 'page');
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

  it('shows the tag its nav item names, and none when the hook returns null', () => {
    let tag: string | null = 'New';
    navItems.push({ path: '/bob', label: 'Bob', useSidebarTag: () => tag });
    renderNav();
    expect(bobRow()).toContainElement(screen.getByTestId('sidenav-nav-bob-tag'));
    expect(screen.getByTestId('sidenav-nav-bob-tag')).toHaveTextContent('New');

    tag = null;
    renderNav();
    expect(screen.getAllByTestId('sidenav-nav-bob').at(-1)).toHaveTextContent(/^Bob$/);
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

  it('shows the tag a contributed row names', () => {
    navItems.push({ path: '/launch', label: 'Launch Pad', sidebar: true, useSidebarTag: () => 'New' });
    renderNav();
    expect(contributedRow()).toContainElement(screen.getByTestId('sidenav-nav-premium-launch-tag'));
  });

  it('does not draw Bob twice when its nav item opts in too', () => {
    navItems.push({ path: '/bob', label: 'Bob', sidebar: true });
    renderNav();
    expect(screen.getAllByTestId('sidenav-nav-bob')).toHaveLength(1);
    expect(screen.queryByTestId('sidenav-nav-premium-bob')).not.toBeInTheDocument();
  });

  // The pinned section is items.slice(0, 2), so a contributed row placed among the conditional core
  // rows would take the second slot for any user who sees none of them, and push Files Manager out.
  it('never takes the pinned slot, even when it is the only conditional row', () => {
    navItems.push({ path: '/launch', label: 'Launch Pad', sidebar: true });

    renderNav('pinned');
    expect(screen.getByTestId('sidenav-nav-new-chat')).toBeInTheDocument();
    expect(screen.getByTestId('sidenav-nav-files')).toBeInTheDocument();
    expect(contributedRow()).not.toBeInTheDocument();
  });

  it('sits directly after Files Manager', () => {
    navItems.push({ path: '/launch', label: 'Launch Pad', sidebar: true });
    const rowIds = (container: HTMLElement) =>
      within(container)
        .getAllByRole('button')
        .map(row => row.getAttribute('data-testid'))
        .filter(id => id?.startsWith('sidenav-nav-'));

    const all = rowIds(renderNav().container);
    expect(all.indexOf('sidenav-nav-premium-launch')).toBe(all.indexOf('sidenav-nav-files') + 1);

    // Files Manager is the last pinned row here, so the contributed row heads the scrolling section.
    expect(rowIds(renderNav('scroll').container)[0]).toBe('sidenav-nav-premium-launch');
  });

  it('draws one row for paths that differ only in punctuation, so no key or test id repeats', () => {
    navItems.push({ path: '/a-b', label: 'First', sidebar: true }, { path: '/a/b', label: 'Second', sidebar: true });
    renderNav();
    const rows = screen.getAllByTestId('sidenav-nav-premium-a-b');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('First');
  });
});

/**
 * The default system prompts ship on every turn, so a sidebar row they name that does not exist sends
 * every user to a dead end. Any quoted name in a sentence about the sidebar must be a row the
 * baseline user (no flags, no overlay) actually sees.
 */
describe('default prompts', () => {
  const defaultPrompts = Object.values(settingsMap).flatMap(setting =>
    setting.key.endsWith('Prompt') && typeof setting.defaultValue === 'string'
      ? [{ key: setting.key, text: setting.defaultValue }]
      : []
  );

  const sidebarNamesIn = (text: string) =>
    text
      // A new sentence starts with a capital or a quote, so a mid-sentence "the ? shortcut" does not split one.
      .split(/(?<=[.!?])\s+(?=[A-Z"])/)
      .filter(sentence => /\b(side ?bar|sidenav)\b/i.test(sentence))
      .flatMap(sentence => [...sentence.matchAll(/"([^"]+)"/g)].map(match => match[1]));

  it('reads the help center prompt among them', () => {
    expect(defaultPrompts.map(prompt => prompt.key)).toContain('HelpCenterPrompt');
  });

  it('keeps a quoted name after a mid-sentence ? in its sidebar sentence', () => {
    expect(sidebarNamesIn('Open "Help" or press the ? key in the sidebar. Then "Other" elsewhere.')).toEqual(['Help']);
  });

  it('name only sidebar rows that exist', () => {
    renderNav();
    const rowLabels = screen
      .getAllByRole('button')
      .filter(row => row.getAttribute('data-testid')?.startsWith('sidenav-nav-'))
      .map(row => row.textContent);

    for (const { key, text } of defaultPrompts) {
      for (const name of sidebarNamesIn(text)) {
        expect(rowLabels, `${key} names a "${name}" sidebar row`).toContain(name);
      }
    }
  });
});

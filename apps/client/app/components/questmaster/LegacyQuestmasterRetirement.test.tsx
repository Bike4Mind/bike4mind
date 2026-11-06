import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { mockSettings, mockUserId, mockPathname, mockGet, mockToast } = vi.hoisted(() => ({
  mockSettings: { current: [] as Array<{ settingName: string; settingValue: unknown }> },
  mockUserId: { current: 'user-1' as string | undefined },
  mockPathname: { current: '/' },
  mockGet: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useServerSettings: () => ({ serverSettings: mockSettings.current }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: { currentUser?: { id: string } }) => unknown) =>
    selector({ currentUser: mockUserId.current ? { id: mockUserId.current } : undefined }),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: (...a: unknown[]) => mockGet(...a) } }));
vi.mock('@tanstack/react-router', () => ({ useLocation: () => ({ pathname: mockPathname.current }) }));
vi.mock('sonner', () => ({ toast: { info: (...a: unknown[]) => mockToast(...a) } }));

import {
  LegacyQuestmasterBanner,
  LegacyQuestmasterNotice,
  archiveNoticeMessage,
  formatShutdownDate,
} from './LegacyQuestmasterRetirement';

const appTheme = extendTheme({ ...getThemeConfig() });

function renderWithProviders(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <CssVarsProvider theme={appTheme}>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </CssVarsProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockSettings.current = [];
  mockUserId.current = 'user-1';
  mockPathname.current = '/';
  mockGet.mockResolvedValue({ data: { archivedCount: 2 } });
});

describe('formatShutdownDate', () => {
  it('formats a calendar date without shifting it by time zone', () => {
    expect(formatShutdownDate('2027-01-31')).toBe('January 31, 2027');
  });

  it('ignores an empty or invalid value', () => {
    expect(formatShutdownDate('')).toBeNull();
    expect(formatShutdownDate(undefined)).toBeNull();
    expect(formatShutdownDate('2027-02-30')).toBeNull();
    expect(formatShutdownDate('next month')).toBeNull();
  });
});

describe('LegacyQuestmasterBanner', () => {
  it('names the shutdown date and the archive folder when the date is set', () => {
    mockSettings.current = [{ settingName: 'QuestMasterLegacyShutdownDate', settingValue: '2027-01-31' }];

    renderWithProviders(<LegacyQuestmasterBanner />);

    const text = screen.getByTestId('legacy-questmaster-banner-text').textContent;
    expect(text).toContain('being retired on January 31, 2027.');
    expect(text).toContain('Questmaster archive');
  });

  it('still names the archive folder, without a date, while none is set', () => {
    renderWithProviders(<LegacyQuestmasterBanner />);

    const text = screen.getByTestId('legacy-questmaster-banner-text').textContent;
    expect(text).toContain('Quest Master v4 and v5 are being retired.');
    expect(text).toContain('Questmaster archive');
  });
});

describe('LegacyQuestmasterNotice', () => {
  it('tells a user with converted plans once per device', async () => {
    const { unmount } = renderWithProviders(<LegacyQuestmasterNotice />);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(archiveNoticeMessage(2), expect.anything()));
    expect(mockGet).toHaveBeenCalledWith('/api/quest-master-plans/legacy-archive');
    unmount();

    renderWithProviders(<LegacyQuestmasterNotice />);
    await new Promise(r => setTimeout(r, 0));
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('says nothing to a user without converted plans', async () => {
    mockGet.mockResolvedValue({ data: { archivedCount: 0 } });

    renderWithProviders(<LegacyQuestmasterNotice />);

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 0));
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('does not ask on the legacy views, whose banner already says it', async () => {
    mockPathname.current = '/quests';

    renderWithProviders(<LegacyQuestmasterNotice />);

    await new Promise(r => setTimeout(r, 0));
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('does not ask while signed out', async () => {
    mockUserId.current = undefined;

    renderWithProviders(<LegacyQuestmasterNotice />);

    await new Promise(r => setTimeout(r, 0));
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('uses the singular for one plan', () => {
    expect(archiveNoticeMessage(1)).toBe(
      'Your Quest Master plan was saved as a markdown file in the "Questmaster archive" folder of your files.'
    );
  });
});

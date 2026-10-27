import React from 'react';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';

// AdminPage statically imports many admin tabs that are irrelevant here. Replace each with a null
// stub, whatever its export name. The tabs it loads only via next/dynamic or React.lazy are covered
// by the next/dynamic mock below. Keep the real chat wiring: the SessionContainer host is the bug
// site, so it must sit inside AdminChatDock's slot and not in a clipped box.
const STUBBED_MODULES = [
  '../Knowledge/KnowledgeModal',
  './AdminModalTab',
  './AdminWhatsNewModalsTab',
  './Analytics',
  './ApiCookbookTab',
  './ApiReferenceTab',
  './CreditAnalysis',
  './DocumentationTab',
  './EmailMarketingTab',
  './EmbedKeysTab',
  './IdentityProvidersTab',
  './InviteCenter',
  './LLMDashboardTab',
  './ModelLogsTab',
  './OrganizationsTab',
  './RapidReplyTab',
  './ReleaseNotes/AdminReleaseNotesTab',
  './SecretsRotationTab',
  './Subscriptions',
  './SystemSecretsTab',
  './ToolDefinitionsTab',
  './Users',
  './VoiceSettingsTab',
  './shared/AdminCommandPalette',
  './useAdminNotifications',
  './useAdminTabUrlSync',
  './AdminSettingsTab',
  './AdminSystemHealthTab',
  './EmailVerificationTab',
  './Feedback',
  './FilesTab',
  './ManageGearsTab',
  './SystemPromptsTab',
  './WorldTime',
];

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@client/app/components/Session/SessionContainer', () => ({
  default: () => <div data-testid="session-container-stub" />,
}));
vi.mock('@client/app/components/Session/NotebookFilepondProvider', () => ({
  NotebookFilepondProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { isAdmin: true } }),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({ data: { id: 'admin-session' } }) },
}));
vi.mock('@client/app/hooks/data/admin', () => ({
  useLiveOpsTriageEnv: () => ({ data: undefined, isError: false }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useGetSession: () => ({ isPending: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });

describe('AdminPage chat slot', () => {
  let AdminPage: React.ComponentType;

  beforeAll(async () => {
    // __esModule makes the Proxy a valid ES module for interop; `then` must be undefined or
    // await import() treats the Proxy as a thenable and never resolves.
    const stub = () =>
      new Proxy(
        {},
        {
          get: (_, key) => (key === '__esModule' ? true : key === 'then' ? undefined : () => null),
          has: () => true,
        }
      );
    for (const mod of STUBBED_MODULES) vi.doMock(mod, stub);
    AdminPage = (await import('./AdminPage')).default;
  });

  beforeEach(() => {
    vi.mocked(window.matchMedia).mockImplementation(
      query =>
        ({
          matches: true,
          media: query,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList
    );
  });

  it('mounts the chat in a clipped slot as the pill, then in flow once docked', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <AdminPage />
      </CssVarsProvider>
    );
    const slot = () => screen.getByTestId('admin-chat-slot');
    expect(slot().contains(screen.getByTestId('session-container-stub'))).toBe(true);
    expect(getComputedStyle(slot()).width).toBe('0px');
    // the mount effect must have put the chat in the pill state
    expect(useSessionLayout.getState().layout).toBe('floatingChat');
    expect(useSessionLayout.getState().floatingChatMinimized).toBe(true);

    for (const layout of ['dockRight', 'dockBottom'] as const) {
      act(() => setSessionLayout({ layout }));
      expect(getComputedStyle(slot()).position).not.toBe('absolute');
      expect(slot().contains(screen.getByTestId('session-container-stub'))).toBe(true);
      // no clipped (0px) ancestor may sit between the chat and the slot
      for (
        let el = screen.getByTestId('session-container-stub').parentElement;
        el && el !== slot();
        el = el.parentElement
      ) {
        expect(getComputedStyle(el).width).not.toBe('0px');
      }
    }
  });
});

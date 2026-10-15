import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ApiTabContent from './ApiTabContent';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/UserApiKeysSection', () => ({
  default: () => <div data-testid="section-account-keys" />,
}));
vi.mock('@client/app/components/ProfileModal/AgentConnectSection', () => ({
  default: () => <div data-testid="section-agent-connect" />,
}));
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/ApiKeysSection', () => ({
  default: () => <div data-testid="section-provider-keys" />,
}));
vi.mock('@client/app/components/admin/CreditAnalysis/components/UsageDashboard', () => ({
  UsageDashboard: () => <div data-testid="usage-dashboard" />,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ApiTabContent />
    </CssVarsProvider>
  );

describe('ApiTabContent', () => {
  beforeEach(() => navigate.mockReset());

  it('puts account API keys ahead of provider (BYOK) keys', () => {
    renderTab();
    const account = screen.getByTestId('section-account-keys');
    const provider = screen.getByTestId('section-provider-keys');
    expect(account.compareDocumentPosition(provider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('links to the Usage tab instead of rendering its own spend dashboard', () => {
    renderTab();
    expect(screen.queryByTestId('usage-dashboard')).toBeNull();
    fireEvent.click(screen.getByTestId('api-keys-usage-link-btn'));
    expect(navigate).toHaveBeenCalledWith({ to: '/profile', search: { tab: 'usage' }, replace: true });
  });
});

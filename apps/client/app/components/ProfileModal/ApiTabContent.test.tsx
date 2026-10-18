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

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = (props: { replaceHistory?: boolean } = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ApiTabContent {...props} />
    </CssVarsProvider>
  );

describe('ApiTabContent', () => {
  beforeEach(() => navigate.mockReset());

  it('orders account keys, the spend link, agent connect, then provider (BYOK) keys', () => {
    renderTab();
    const order = ['section-account-keys', 'api-keys-usage-link', 'section-agent-connect', 'section-provider-keys'].map(
      id => screen.getByTestId(id)
    );
    for (let i = 0; i < order.length - 1; i++) {
      expect(order[i].compareDocumentPosition(order[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('links to the Usage tab instead of rendering its own spend dashboard', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('api-keys-usage-link-btn'));
    expect(navigate).toHaveBeenCalledWith({ to: '/profile', search: { tab: 'usage' }, replace: true });
  });

  it('pushes a history entry for the Usage link when hosted off the profile page', () => {
    renderTab({ replaceHistory: false });
    fireEvent.click(screen.getByTestId('api-keys-usage-link-btn'));
    expect(navigate).toHaveBeenCalledWith({ to: '/profile', search: { tab: 'usage' }, replace: false });
  });
});

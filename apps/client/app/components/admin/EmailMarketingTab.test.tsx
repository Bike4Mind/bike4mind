import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('./email/EmailTemplatesPanel', () => ({ default: () => <div data-testid="email-templates-panel-stub" /> }));
vi.mock('./email/EmailJobsPanel', () => ({ default: () => <div data-testid="email-campaigns-panel-stub" /> }));

import EmailMarketingTab from './EmailMarketingTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <EmailMarketingTab />
    </CssVarsProvider>
  );

describe('EmailMarketingTab', () => {
  it('opens with the page header: title, description and the help action', () => {
    const { container } = renderTab();
    const header = screen.getByTestId('admin-page-header');

    expect(container.firstElementChild?.firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^Email marketing$/);
    expect(header).toHaveTextContent('Reusable email templates and the campaigns that send them');
    expect(within(header).getByTestId('help-button-admin-email-marketing')).toBeInTheDocument();
  });

  it('opens on templates and switches between the templates and campaigns views', () => {
    renderTab();
    const templates = screen.getByTestId('email-marketing-views-templates-btn');
    const campaigns = screen.getByTestId('email-marketing-views-campaigns-btn');

    expect(templates).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('email-templates-panel-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('email-campaigns-panel-stub')).not.toBeInTheDocument();

    fireEvent.click(campaigns);
    expect(campaigns).toHaveAttribute('aria-pressed', 'true');
    expect(templates).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('email-campaigns-panel-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('email-templates-panel-stub')).not.toBeInTheDocument();

    fireEvent.click(templates);
    expect(screen.getByTestId('email-templates-panel-stub')).toBeInTheDocument();
  });
});

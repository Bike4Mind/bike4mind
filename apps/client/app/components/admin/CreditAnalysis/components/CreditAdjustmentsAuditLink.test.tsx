import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
import { CreditAdjustmentsAuditLink } from './CreditAdjustmentsAuditLink';

const theme = extendTheme({ ...getThemeConfig() });

describe('CreditAdjustmentsAuditLink', () => {
  it('opens the Audit Log filtered to credit actions', () => {
    render(
      <CssVarsProvider theme={theme}>
        <CreditAdjustmentsAuditLink />
      </CssVarsProvider>
    );

    fireEvent.click(screen.getByTestId('credit-adjustments-audit-log-link'));

    expect(navigate).toHaveBeenCalledWith({
      to: '/admin',
      search: { tab: 'audit-log', category: 'credits' },
    });
  });
});

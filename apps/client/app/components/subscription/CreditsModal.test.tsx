import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : _key) }),
}));
vi.mock('@client/app/hooks/useEffectiveCredits', () => ({ useEffectiveCredits: () => 100 }));
vi.mock('@client/app/hooks/data/credits', () => ({ useGetCreditTransactions: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/data/teamPlanSettings', () => ({ useLowCreditsThreshold: () => 10 }));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: () => ({ selectedAccount: null }),
}));
vi.mock('../Credits/PaymentButton', () => ({ default: () => null }));

import CreditsModal from './CreditsModal';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('CreditsModal usage link', () => {
  beforeEach(() => navigate.mockClear());

  it('closes the modal and opens the profile usage tab', () => {
    const onClose = vi.fn();
    render(
      <CssVarsProvider theme={appTheme}>
        <CreditsModal open onClose={onClose} />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByTestId('credits-modal-see-usage-link'));
    expect(onClose).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ to: '/profile', search: { tab: 'usage' } });
  });
});

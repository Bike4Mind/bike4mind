import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ModelInfo } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import LockedModelsSection from './LockedModelsSection';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const locked = (id: string, reason: 'requires_paid_plan' | 'org_policy') =>
  ({ id, name: id, type: 'text', access: { locked: true, reason } }) as unknown as ModelInfo;

describe('LockedModelsSection', () => {
  it('shows org-locked models with the org reason and no upgrade button', () => {
    render(<LockedModelsSection models={[locked('blocked', 'org_policy')]} onUpgrade={vi.fn()} />, {
      wrapper: TestWrapper,
    });

    expect(screen.getByText('Not allowed by your organization')).toBeTruthy();
    expect(screen.getByTestId('org-locked-model-row-blocked').getAttribute('title')).toBe(
      'Your organization does not allow this model'
    );
    expect(screen.queryByTestId('locked-models-upgrade-btn')).toBeNull();
    expect(screen.queryByTestId('locked-models-section')).toBeNull();
  });

  it('keeps the paid-plan group and its upgrade action apart from the org group', () => {
    const onUpgrade = vi.fn();
    render(
      <LockedModelsSection
        models={[locked('paid', 'requires_paid_plan'), locked('blocked', 'org_policy')]}
        onUpgrade={onUpgrade}
      />,
      { wrapper: TestWrapper }
    );

    expect(screen.getByTestId('locked-model-row-paid')).toBeTruthy();
    expect(screen.getByTestId('org-locked-model-row-blocked')).toBeTruthy();
    expect(screen.queryByTestId('locked-model-row-blocked')).toBeNull();
    fireEvent.click(screen.getByTestId('locked-models-upgrade-btn'));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it('renders nothing with no locked models', () => {
    const { container } = render(<LockedModelsSection models={[]} />, { wrapper: TestWrapper });

    expect(container.textContent).toBe('');
  });
});

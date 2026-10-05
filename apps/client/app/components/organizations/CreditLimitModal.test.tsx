import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import CreditLimitModal from './CreditLimitModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderModal = (onSave: (value: number | null) => Promise<unknown>, onClose = vi.fn()) => {
  render(
    <CreditLimitModal
      open
      onClose={onClose}
      title="Limit"
      description="Desc"
      currentValue={null}
      allowZero={false}
      clearLabel="Remove limit"
      saving={false}
      onSave={onSave}
    />,
    { wrapper: TestWrapper }
  );
  return onClose;
};

const type = (value: string) => fireEvent.change(screen.getByTestId('credit-limit-input'), { target: { value } });

describe('CreditLimitModal', () => {
  it('closes after a successful save', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    const onClose = renderModal(onSave);
    type('100');
    fireEvent.click(screen.getByTestId('credit-limit-save-btn'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(100);
  });

  it('stays open when the save rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('boom'));
    const onClose = renderModal(onSave);
    type('100');
    fireEvent.click(screen.getByTestId('credit-limit-save-btn'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(100));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('credit-limit-modal')).toBeTruthy();
  });

  it('rejects a fractional value', () => {
    const onSave = vi.fn();
    renderModal(onSave);
    type('0.4');
    const saveButton = screen.getByTestId('credit-limit-save-btn') as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    fireEvent.submit(screen.getByTestId('credit-limit-input').closest('form')!);
    expect(onSave).not.toHaveBeenCalled();
  });
});

import type { ComponentProps, ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import SeatCountInput from './SeatCountInput';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderInput = (props: Partial<ComponentProps<typeof SeatCountInput>> = {}) => {
  const onChange = vi.fn();
  const onInvalidChange = vi.fn();
  render(
    <TestWrapper>
      <SeatCountInput
        value={5}
        min={3}
        max={10}
        onChange={onChange}
        onInvalidChange={onInvalidChange}
        ariaLabel="Seats"
        testId="seat-count-input"
        classNamePrefix="seat-count"
        {...props}
      />
    </TestWrapper>
  );
  return { onChange, onInvalidChange, input: screen.getByTestId('seat-count-input') as HTMLInputElement };
};

describe('SeatCountInput', () => {
  it('reports a typed number, rounded', async () => {
    const { onChange, input } = renderInput();
    const user = userEvent.setup({ delay: null });
    await user.clear(input);
    await user.type(input, '7.4');

    expect(onChange).toHaveBeenLastCalledWith(7);
  });

  it('flags an empty field as invalid and clears the flag on blur', async () => {
    const { onInvalidChange, input } = renderInput();
    const user = userEvent.setup({ delay: null });
    await user.clear(input);
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);

    await user.tab();
    expect(onInvalidChange).toHaveBeenLastCalledWith(false);
    expect(input.value).toBe('5');
  });

  it('steps within the range and disables the buttons at the edges', async () => {
    const { onChange } = renderInput({ value: 10 });
    const user = userEvent.setup({ delay: null });

    expect(screen.getByRole('button', { name: 'Increase seats' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Decrease seats' }));
    expect(onChange).toHaveBeenCalledWith(9);
  });
});

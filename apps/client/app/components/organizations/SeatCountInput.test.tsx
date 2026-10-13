import type { ComponentProps, ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('flags an empty field as invalid and keeps it flagged on blur', async () => {
    const { onChange, onInvalidChange, input } = renderInput();
    const user = userEvent.setup({ delay: null });
    await user.clear(input);
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);

    await user.tab();
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);
    expect(input.value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ['above the maximum', '500'],
    ['below the minimum', '2'],
    ['negative', '-5'],
    ['scientific notation above the maximum', '1e3'],
    ['non-numeric text', 'abc'],
  ])('treats a value %s as invalid, keeps it on blur and never reports it', async (_name, text) => {
    const { onChange, onInvalidChange, input } = renderInput();
    const user = userEvent.setup({ delay: null });
    fireEvent.change(input, { target: { value: text } });

    expect(onInvalidChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId('seat-count-input-error').textContent).toBe('Must be between 3 and 10');
    expect(onChange).not.toHaveBeenCalled();

    const shown = input.value;
    await user.tab();
    expect(input.value).toBe(shown);
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);
  });

  it('clears the error once the draft is back in range', async () => {
    const { onChange, onInvalidChange, input } = renderInput();
    const user = userEvent.setup({ delay: null });
    await user.clear(input);
    await user.type(input, '500');
    expect(screen.queryByTestId('seat-count-input-error')).not.toBeNull();

    await user.clear(input);
    await user.type(input, '8');
    expect(screen.queryByTestId('seat-count-input-error')).toBeNull();
    expect(onInvalidChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenLastCalledWith(8);
  });

  it('derives the stepper labels from the field label', () => {
    renderInput({ ariaLabel: 'Team size' });

    expect(screen.getByRole('button', { name: 'Decrease team size' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Increase team size' })).toBeTruthy();
  });

  it('steps within the range and disables the buttons at the edges', async () => {
    const { onChange } = renderInput({ value: 10 });
    const user = userEvent.setup({ delay: null });

    expect(screen.getByRole('button', { name: 'Increase seats' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Decrease seats' }));
    expect(onChange).toHaveBeenCalledWith(9);
  });
});

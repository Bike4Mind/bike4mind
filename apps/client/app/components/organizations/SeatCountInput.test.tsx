import type { ComponentProps, ReactNode } from 'react';
import { useState } from 'react';
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

const element = (props: Partial<ComponentProps<typeof SeatCountInput>> = {}) => (
  <TestWrapper>
    <SeatCountInput
      value={5}
      min={3}
      max={10}
      onChange={props.onChange ?? vi.fn()}
      onInvalidChange={props.onInvalidChange}
      ariaLabel="Seats"
      testId="seat-count-input"
      classNamePrefix="seat-count"
      {...props}
    />
  </TestWrapper>
);

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

  it('steps from the displayed draft, clears the error and re-enables submit', async () => {
    const { onChange, onInvalidChange, input } = renderInput();
    const user = userEvent.setup({ delay: null });
    fireEvent.change(input, { target: { value: '999' } });
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole('button', { name: 'Decrease seats' }));
    expect(onChange).toHaveBeenLastCalledWith(9);
    expect(screen.queryByTestId('seat-count-input-error')).toBeNull();
    expect(onInvalidChange).toHaveBeenLastCalledWith(false);
  });

  it('matches the stepper disabled state to an out-of-range draft, not the hidden value', () => {
    const { input } = renderInput({ value: 3 });
    fireEvent.change(input, { target: { value: '999' } });

    // The draft clamps to the maximum, so decrease is live and increase is not.
    expect(screen.getByRole('button', { name: 'Decrease seats' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Increase seats' }).hasAttribute('disabled')).toBe(true);
  });

  it('clamps a below-minimum draft into the stepper instead of falling back to the value', async () => {
    const { onChange, input } = renderInput({ value: 5 });
    const user = userEvent.setup({ delay: null });
    fireEvent.change(input, { target: { value: '1' } });

    expect(screen.getByRole('button', { name: 'Decrease seats' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Increase seats' }));
    expect(onChange).toHaveBeenLastCalledWith(4);
  });

  it('falls back to the value for the stepper when the draft is not a number', async () => {
    const { onChange, input } = renderInput({ value: 5 });
    const user = userEvent.setup({ delay: null });
    fireEvent.change(input, { target: { value: 'abc' } });

    expect(screen.getByRole('button', { name: 'Decrease seats' }).hasAttribute('disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Decrease seats' }));
    expect(onChange).toHaveBeenLastCalledWith(4);
  });

  it('accepts 2.6 as 3 with a minimum of 3', () => {
    const { onChange, onInvalidChange, input } = renderInput();
    fireEvent.change(input, { target: { value: '2.6' } });

    expect(onChange).toHaveBeenCalledWith(3);
    expect(onInvalidChange).not.toHaveBeenCalledWith(true);
  });

  it('rejects 10.5 with a maximum of 10', () => {
    const { onChange, onInvalidChange, input } = renderInput();
    fireEvent.change(input, { target: { value: '10.5' } });

    expect(onChange).not.toHaveBeenCalled();
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);
  });

  describe('when min or max change under a held draft', () => {
    it('reports an invalid draft that becomes valid when max rises', () => {
      const onChange = vi.fn();
      const onInvalidChange = vi.fn();
      const { rerender } = render(element({ onChange, onInvalidChange }));
      fireEvent.change(screen.getByTestId('seat-count-input'), { target: { value: '30' } });
      expect(onChange).not.toHaveBeenCalled();
      expect(onInvalidChange).toHaveBeenLastCalledWith(true);

      rerender(element({ onChange, onInvalidChange, max: 50 }));
      expect(onChange).toHaveBeenLastCalledWith(30);
      expect(onInvalidChange).toHaveBeenLastCalledWith(false);
      expect(screen.queryByTestId('seat-count-input-error')).toBeNull();
    });

    it('flags a valid draft that becomes invalid when max drops', () => {
      const onChange = vi.fn();
      const onInvalidChange = vi.fn();
      const { rerender } = render(element({ onChange, onInvalidChange }));
      fireEvent.change(screen.getByTestId('seat-count-input'), { target: { value: '8' } });
      expect(onInvalidChange).toHaveBeenLastCalledWith(false);

      rerender(element({ onChange, onInvalidChange, value: 5, max: 6 }));
      expect(onInvalidChange).toHaveBeenLastCalledWith(true);
      expect(screen.getByTestId('seat-count-input-error').textContent).toBe('Must be between 3 and 6');
    });

    it('keeps a typed draft when a range change also clamps the value, and re-reports it', () => {
      const onChange = vi.fn();
      const Harness = () => {
        const [range, setRange] = useState({ min: 2, max: 10 });
        const [requested, setRequested] = useState(2);
        const value = Math.min(Math.max(requested, range.min), range.max);
        return (
          <>
            <button onClick={() => setRange({ min: 5, max: 20 })}>widen</button>
            <SeatCountInput
              value={value}
              min={range.min}
              max={range.max}
              onChange={seats => {
                onChange(seats);
                setRequested(seats);
              }}
              ariaLabel="Seats"
              testId="seat-count-input"
              classNamePrefix="seat-count"
            />
          </>
        );
      };
      render(
        <TestWrapper>
          <Harness />
        </TestWrapper>
      );
      const input = screen.getByTestId('seat-count-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '15' } });
      expect(input.value).toBe('15');

      fireEvent.click(screen.getByRole('button', { name: 'widen' }));

      expect(input.value).toBe('15');
      expect(onChange).toHaveBeenLastCalledWith(15);
      expect(screen.queryByTestId('seat-count-input-error')).toBeNull();
    });
  });

  describe('when the parent value changes under a draft', () => {
    it('shows the new parent value instead of a stale valid draft', () => {
      const { rerender } = render(element({ value: 5 }));
      const input = screen.getByTestId('seat-count-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '7' } });
      expect(input.value).toBe('7');

      rerender(element({ value: 6 }));
      expect(input.value).toBe('6');
    });

    it('keeps an out-of-range draft and its error', () => {
      const { rerender } = render(element({ value: 5 }));
      const input = screen.getByTestId('seat-count-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '999' } });
      expect(screen.getByTestId('seat-count-input-error')).toBeTruthy();

      rerender(element({ value: 6 }));
      expect(input.value).toBe('999');
      expect(screen.getByTestId('seat-count-input-error').textContent).toBe('Must be between 3 and 10');
    });

    it('keeps a fractional draft as typed until blur under a stateful parent', () => {
      const Harness = () => {
        const [seats, setSeats] = useState(5);
        return (
          <TestWrapper>
            <SeatCountInput
              value={seats}
              min={3}
              max={10}
              onChange={setSeats}
              ariaLabel="Seats"
              testId="seat-count-input"
              classNamePrefix="seat-count"
            />
          </TestWrapper>
        );
      };
      render(<Harness />);
      const input = screen.getByTestId('seat-count-input') as HTMLInputElement;

      fireEvent.change(input, { target: { value: '5.6' } });
      expect(input.value).toBe('5.6');

      fireEvent.blur(input);
      expect(input.value).toBe('6');
    });
  });
});

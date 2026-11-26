import React, { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { FormControl } from '@mui/joy';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { OptionalDateInput } from './OptionalDateInput';

const appTheme = extendTheme({ ...getThemeConfig() });

type HarnessProps = { initial: string; min?: string; max?: string; disabled?: boolean; error?: boolean };

const Harness = ({ initial, min, max, disabled, error }: HarnessProps) => {
  const [value, setValue] = useState(initial);
  return (
    <CssVarsProvider theme={appTheme}>
      <OptionalDateInput
        value={value}
        onChange={setValue}
        emptyLabel="No expiry"
        setLabel="Set expiry date"
        clearLabel="Remove expiry date"
        initialDate={() => '2030-01-15'}
        min={min}
        max={max}
        disabled={disabled}
        error={error}
        testId="expiry"
      />
      <output data-testid="value">{value}</output>
    </CssVarsProvider>
  );
};

describe('OptionalDateInput', () => {
  it('shows the empty label instead of a native date input while there is no date', () => {
    render(<Harness initial="" />);
    expect(screen.getByTestId('expiry-empty')).toHaveTextContent('No expiry');
    expect(screen.queryByTestId('expiry')).not.toBeInTheDocument();
  });

  it('fills in the initial date and focuses the input when a date is added', () => {
    render(<Harness initial="" />);
    fireEvent.click(screen.getByTestId('expiry-set-btn'));
    expect(screen.getByTestId('expiry')).toHaveValue('2030-01-15');
    expect(screen.getByTestId('expiry')).toHaveFocus();
    expect(screen.getByTestId('value')).toHaveTextContent('2030-01-15');
  });

  it('returns to the empty state and focuses the set button when the date is removed', () => {
    render(<Harness initial="2031-02-03" />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove expiry date' }));
    expect(screen.getByTestId('expiry-empty')).toBeInTheDocument();
    expect(screen.getByTestId('value')).toBeEmptyDOMElement();
    expect(screen.getByTestId('expiry-set-btn')).toHaveFocus();
  });

  it('keeps the input while a segment is being retyped and collapses only once focus leaves', () => {
    render(<Harness initial="2031-02-03" />);
    const input = screen.getByTestId('expiry');
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('value')).toBeEmptyDOMElement();
    expect(screen.getByTestId('expiry')).toBe(input);
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: '2031-02-09' } });
    expect(screen.getByTestId('value')).toHaveTextContent('2031-02-09');

    fireEvent.change(input, { target: { value: '' } });
    act(() => screen.getByRole('button', { name: 'Remove expiry date' }).focus());
    expect(screen.getByTestId('expiry')).toBe(input);

    act(() => input.focus());
    act(() => input.blur());
    expect(screen.getByTestId('expiry-empty')).toBeInTheDocument();
  });

  it('passes min and max through to the native input', () => {
    render(<Harness initial="2031-02-03" min="2031-01-01" max="2031-12-31" />);
    expect(screen.getByTestId('expiry')).toHaveAttribute('min', '2031-01-01');
    expect(screen.getByTestId('expiry')).toHaveAttribute('max', '2031-12-31');
  });

  it('cannot be set while disabled', () => {
    render(<Harness initial="" disabled />);
    const setButton = screen.getByTestId('expiry-set-btn');
    expect(setButton).toBeDisabled();
    fireEvent.click(setButton);
    expect(screen.getByTestId('expiry-empty')).toBeInTheDocument();
    expect(screen.getByTestId('value')).toBeEmptyDOMElement();
  });

  it('cannot be edited or cleared while disabled', () => {
    render(<Harness initial="2031-02-03" disabled />);
    expect(screen.getByTestId('expiry')).toBeDisabled();
    const clearButton = screen.getByRole('button', { name: 'Remove expiry date' });
    expect(clearButton).toBeDisabled();
    fireEvent.click(clearButton);
    expect(screen.getByTestId('expiry')).toHaveValue('2031-02-03');
    expect(screen.getByTestId('value')).toHaveTextContent('2031-02-03');
  });

  it('collapses an emptied field that is disabled mid-edit', () => {
    const { rerender } = render(<Harness initial="2031-02-03" />);
    const input = screen.getByTestId('expiry');
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('expiry')).toBe(input);

    rerender(<Harness initial="2031-02-03" disabled />);
    expect(screen.getByTestId('expiry-empty')).toBeInTheDocument();
    expect(screen.getByTestId('expiry-set-btn')).toBeDisabled();
  });

  it('marks the input as errored only when error is set', () => {
    const { rerender } = render(<Harness initial="2031-02-03" />);
    expect(screen.getByTestId('expiry-root')).not.toHaveClass('Mui-error');
    rerender(<Harness initial="2031-02-03" error />);
    expect(screen.getByTestId('expiry-root')).toHaveClass('Mui-error');
  });

  describe('inside a FormControl', () => {
    const InControl = ({
      initial,
      control,
      own,
    }: {
      initial: string;
      control: { error?: boolean; disabled?: boolean };
      own?: { error?: boolean; disabled?: boolean };
    }) => (
      <CssVarsProvider theme={appTheme}>
        <FormControl {...control}>
          <OptionalDateInput
            value={initial}
            onChange={() => undefined}
            emptyLabel="No expiry"
            setLabel="Set expiry date"
            clearLabel="Remove expiry date"
            initialDate={() => '2030-01-15'}
            testId="expiry"
            {...own}
          />
        </FormControl>
      </CssVarsProvider>
    );
    const rootOf = (testId: string) => screen.getByTestId(`${testId}-root`);

    it("takes the FormControl's error and disabled when it sets none of its own", () => {
      render(<InControl initial="2031-02-03" control={{ error: true, disabled: true }} />);
      expect(rootOf('expiry')).toHaveClass('MuiInput-colorDanger');
      expect(screen.getByTestId('expiry')).toBeDisabled();
    });

    it("lets its own props win over the FormControl's, as Joy's fields do", () => {
      render(
        <InControl
          initial="2031-02-03"
          control={{ error: true, disabled: true }}
          own={{ error: false, disabled: false }}
        />
      );
      expect(rootOf('expiry')).not.toHaveClass('Mui-error');
      expect(screen.getByTestId('expiry')).toBeEnabled();
    });
  });
});

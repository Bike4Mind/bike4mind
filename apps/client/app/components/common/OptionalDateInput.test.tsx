import React, { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { OptionalDateInput } from './OptionalDateInput';

const appTheme = extendTheme({ ...getThemeConfig() });

const Harness = ({ initial, min, max }: { initial: string; min?: string; max?: string }) => {
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
});

import React, { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { OptionalDateInput } from './OptionalDateInput';

const appTheme = extendTheme({ ...getThemeConfig() });

const Harness = ({ initial }: { initial: string }) => {
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

  it('returns to the empty state when the date is removed or cleared natively', () => {
    render(<Harness initial="2031-02-03" />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove expiry date' }));
    expect(screen.getByTestId('expiry-empty')).toBeInTheDocument();
    expect(screen.getByTestId('value')).toBeEmptyDOMElement();

    fireEvent.click(screen.getByTestId('expiry-set-btn'));
    fireEvent.change(screen.getByTestId('expiry'), { target: { value: '' } });
    expect(screen.getByTestId('expiry-empty')).toBeInTheDocument();
  });
});

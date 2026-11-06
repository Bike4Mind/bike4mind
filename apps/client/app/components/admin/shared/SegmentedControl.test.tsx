import { useState, type ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { SegmentedControl } from './SegmentedControl';

const theme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

type Mode = 'set' | 'add' | 'subtract';
const OPTIONS = [
  { value: 'set', label: 'Set to' },
  { value: 'add', label: 'Add' },
  { value: 'subtract', label: 'Subtract' },
] as const;

describe('SegmentedControl', () => {
  it('renders a labelled group with one pressed button for the current value', () => {
    render(
      <SegmentedControl<Mode>
        options={OPTIONS}
        value="add"
        onChange={vi.fn()}
        aria-label="Adjustment type"
        data-testid="mode"
      />,
      { wrapper: TestWrapper }
    );

    expect(screen.getByRole('group', { name: 'Adjustment type' })).toBe(screen.getByTestId('mode'));
    expect(screen.getByTestId('mode-set')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('mode-add')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('mode-subtract')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('mode-add')).toHaveTextContent('Add');
  });

  it('reports the clicked value and moves the pressed state when controlled', () => {
    const onChange = vi.fn();
    const Controlled = () => {
      const [value, setValue] = useState<Mode>('set');
      return (
        <SegmentedControl<Mode>
          options={OPTIONS}
          value={value}
          onChange={next => {
            onChange(next);
            setValue(next);
          }}
          aria-label="Adjustment type"
          data-testid="mode"
        />
      );
    };
    render(<Controlled />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByTestId('mode-subtract'));

    expect(onChange).toHaveBeenCalledWith('subtract');
    expect(screen.getByTestId('mode-subtract')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('mode-set')).toHaveAttribute('aria-pressed', 'false');
  });
});

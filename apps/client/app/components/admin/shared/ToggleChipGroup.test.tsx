import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ToggleChipGroup, toggleChipSelection } from './ToggleChipGroup';

const appTheme = extendTheme({ ...getThemeConfig() });
const ALL = ['a', 'b', 'c'] as const;

describe('toggleChipSelection', () => {
  it('narrows to the clicked option when everything was selected', () => {
    expect(toggleChipSelection(ALL, ALL, 'b')).toEqual(['b']);
  });

  it('adds and removes options in their canonical order', () => {
    expect(toggleChipSelection(ALL, ['c'], 'a')).toEqual(['a', 'c']);
    expect(toggleChipSelection(ALL, ['a', 'c'], 'a')).toEqual(['c']);
  });

  it('falls back to everything when the last option is removed', () => {
    expect(toggleChipSelection(ALL, ['b'], 'b')).toEqual(['a', 'b', 'c']);
  });
});

describe('ToggleChipGroup', () => {
  const setup = (value: Array<(typeof ALL)[number]>) => {
    const onChange = vi.fn();
    render(
      <CssVarsProvider theme={appTheme}>
        <ToggleChipGroup
          options={ALL.map(option => ({ value: option, label: option.toUpperCase() }))}
          value={value}
          onChange={onChange}
          aria-label="Sources"
          data-testid="chips"
        />
      </CssVarsProvider>
    );
    return onChange;
  };

  it('marks All as pressed, not each option, when everything is selected', () => {
    setup([...ALL]);
    expect(screen.getByTestId('chips-all')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chips-a')).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the next selection and resets through All', () => {
    const onChange = setup(['a']);
    expect(screen.getByTestId('chips-a')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('chips-b'));
    expect(onChange).toHaveBeenLastCalledWith(['a', 'b']);
    fireEvent.click(screen.getByTestId('chips-all'));
    expect(onChange).toHaveBeenLastCalledWith(['a', 'b', 'c']);
  });
});

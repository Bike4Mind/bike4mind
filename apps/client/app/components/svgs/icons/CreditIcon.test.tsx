// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CreditIcon } from './CreditIcon';

describe('CreditIcon', () => {
  it('renders an svg with three paths and the default title', () => {
    render(<CreditIcon />);
    const icon = screen.getByTestId('credit-icon');
    expect(icon.tagName.toLowerCase()).toBe('svg');
    expect(icon.querySelectorAll('path')).toHaveLength(3);
    expect(icon.querySelector('title')?.textContent).toBe('Credits');
  });

  it('allows the title to be overridden', () => {
    render(<CreditIcon title="Credit cost" />);
    expect(screen.getByTestId('credit-icon').querySelector('title')?.textContent).toBe('Credit cost');
  });

  it('forwards MUI icon props', () => {
    render(<CreditIcon fontSize="sm" data-testid="custom" />);
    expect(screen.getByTestId('custom').getAttribute('class')).toContain('MuiSvgIcon-fontSizeSm');
  });
});

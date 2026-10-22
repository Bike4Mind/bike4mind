// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CreditIcon } from './CreditIcon';

describe('CreditIcon', () => {
  it('renders a decorative svg with three paths by default', () => {
    render(<CreditIcon />);
    const icon = screen.getByTestId('credit-icon');
    expect(icon.tagName.toLowerCase()).toBe('svg');
    expect(icon.querySelectorAll('path')).toHaveLength(3);
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.querySelector('title')).toBeNull();
  });

  it('exposes an accessible name when titleAccess is given', () => {
    render(<CreditIcon titleAccess="Credits" />);
    const icon = screen.getByRole('img', { name: 'Credits' });
    expect(icon.querySelector('title')?.textContent).toBe('Credits');
  });

  it('inherits the surrounding text color unless a color is passed', () => {
    render(
      <div style={{ color: 'rgb(12, 34, 56)' }}>
        <CreditIcon />
      </div>
    );
    expect(getComputedStyle(screen.getByTestId('credit-icon')).color).toBe('rgb(12, 34, 56)');
  });

  it('forwards MUI icon props', () => {
    render(<CreditIcon fontSize="sm" data-testid="custom" />);
    expect(screen.getByTestId('custom').getAttribute('class')).toContain('MuiSvgIcon-fontSizeSm');
  });
});

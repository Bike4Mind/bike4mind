import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InlineBar } from './InlineBar';

const bar = () => screen.getByTestId('admin-inline-bar');
const fill = () => bar().firstElementChild as HTMLElement;

describe('InlineBar', () => {
  it('scales the fill against the max and stays out of the accessibility tree', () => {
    render(<InlineBar value={25} max={100} />);
    expect(fill().style.width).toBe('25%');
    expect(bar()).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps a tiny value visible and draws nothing for zero', () => {
    const { unmount } = render(<InlineBar value={1} max={1000} />);
    expect(fill().style.width).toBe('4%');
    unmount();
    render(<InlineBar value={0} max={0} />);
    expect(fill().style.width).toBe('0%');
  });
});

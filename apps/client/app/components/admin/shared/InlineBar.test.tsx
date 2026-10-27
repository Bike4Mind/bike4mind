import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InlineBar } from './InlineBar';

const fill = () => screen.getByTestId('admin-inline-bar').firstElementChild as HTMLElement;

describe('InlineBar', () => {
  it('scales the fill against the max and names the value', () => {
    render(<InlineBar value={25} max={100} label="25 requests" />);
    expect(screen.getByRole('img', { name: '25 requests' })).toBeInTheDocument();
    expect(fill().style.width).toBe('25%');
  });

  it('keeps a tiny value visible and draws nothing for zero', () => {
    const { unmount } = render(<InlineBar value={1} max={1000} label="1" />);
    expect(fill().style.width).toBe('4%');
    unmount();
    render(<InlineBar value={0} max={0} label="0" />);
    expect(fill().style.width).toBe('0%');
  });
});

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import SvgPlate from './SvgPlate';

describe('SvgPlate', () => {
  it('paints a white plate behind its children and merges caller styles', () => {
    render(
      <SvgPlate testId="svg-plate" sx={{ maxHeight: 120 }}>
        <span data-testid="svg-plate-child">art</span>
      </SvgPlate>
    );
    const plate = screen.getByTestId('svg-plate');
    expect(plate).toHaveStyle({ backgroundColor: '#FFFFFF', maxHeight: '120px' });
    expect(plate).toContainElement(screen.getByTestId('svg-plate-child'));
  });
});

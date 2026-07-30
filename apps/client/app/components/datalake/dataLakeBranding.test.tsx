import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DATA_LAKE, DATA_LAKES, DataLakeIcon } from './dataLakeBranding';

describe('dataLakeBranding', () => {
  it('exposes the canonical singular and plural labels', () => {
    expect(DATA_LAKE).toBe('Data Lake');
    expect(DATA_LAKES).toBe('Data Lakes');
  });

  it('renders a single icon and forwards props (data-testid)', () => {
    const { getAllByTestId } = render(<DataLakeIcon data-testid="dl-icon" />);
    expect(getAllByTestId('dl-icon')).toHaveLength(1);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QaTestWrapper } from './testTheme';
import StatusFilters from './StatusFilters';

const facets = { products: ['product-a', 'product-b'], tenants: ['tenant-a'], envs: ['staging'], branches: ['main'] };

describe('StatusFilters', () => {
  it('switches product and clears tenant and env', () => {
    const onChange = vi.fn();
    render(
      <StatusFilters search={{ product: 'product-a', tenant: 'tenant-a' }} facets={facets} onChange={onChange} />,
      {
        wrapper: QaTestWrapper,
      }
    );
    fireEvent.click(screen.getByTestId('qa-filter-product-product-b'));
    expect(onChange).toHaveBeenCalledWith({ product: 'product-b', tenant: undefined, env: undefined });
  });

  it('switches range', () => {
    const onChange = vi.fn();
    render(<StatusFilters search={{ product: 'product-a' }} facets={facets} onChange={onChange} />, {
      wrapper: QaTestWrapper,
    });
    fireEvent.click(screen.getByTestId('qa-filter-range-30d'));
    expect(onChange).toHaveBeenCalledWith({ range: '30d' });
  });

  it('commits the branch on blur, not per keystroke', () => {
    const onChange = vi.fn();
    render(<StatusFilters search={{ product: 'product-a' }} facets={facets} onChange={onChange} />, {
      wrapper: QaTestWrapper,
    });
    const input = screen.getByTestId('qa-filter-branch').querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'feat-x' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ branch: 'feat-x' });
  });

  it('keeps an env and tenant from the URL while the facets load', () => {
    const onChange = vi.fn();
    const search = { product: 'product-a', env: 'staging', tenant: 'tenant-a' };
    const { rerender } = render(<StatusFilters search={search} onChange={onChange} />, { wrapper: QaTestWrapper });
    rerender(<StatusFilters search={search} facets={facets} onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('qa-filter-env')).toHaveTextContent('staging');
    expect(screen.getByTestId('qa-filter-tenant')).toHaveTextContent('tenant-a');
  });

  it('keeps an env from the URL that is not in the facets', () => {
    const onChange = vi.fn();
    const search = { product: 'product-a', env: 'preview-1' };
    const { rerender } = render(<StatusFilters search={search} facets={facets} onChange={onChange} />, {
      wrapper: QaTestWrapper,
    });
    rerender(
      <StatusFilters search={search} facets={{ ...facets, envs: ['staging', 'preview-2'] }} onChange={onChange} />
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('qa-filter-env')).toHaveTextContent('preview-1');
  });
});

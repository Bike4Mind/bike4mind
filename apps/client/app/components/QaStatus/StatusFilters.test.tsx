import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QaTestWrapper } from './testTheme';
import StatusFilters from './StatusFilters';

// Fake only Date: Joy's Select and React still need real timers.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 13, 15));
});
afterEach(() => vi.useRealTimers());

const dateInput = (id: string) => screen.getByTestId(id).querySelector('input') as HTMLInputElement;

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
    expect(screen.getByTestId('qa-filter-product')).toHaveTextContent('product-a');
    fireEvent.click(screen.getByRole('combobox', { name: 'Product' }));
    fireEvent.click(screen.getByRole('option', { name: 'product-b' }));
    expect(onChange).toHaveBeenCalledWith({ product: 'product-b', tenant: undefined, env: undefined });
  });

  it('shows the last 7 days by default with that preset pressed', () => {
    render(<StatusFilters search={{ product: 'product-a' }} facets={facets} onChange={vi.fn()} />, {
      wrapper: QaTestWrapper,
    });
    expect(dateInput('qa-filter-from').value).toBe('2026-11-07');
    expect(dateInput('qa-filter-to').value).toBe('2026-11-13');
    expect(screen.getByTestId('qa-filter-preset-7d')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('qa-filter-preset-30d')).toHaveAttribute('aria-pressed', 'false');
  });

  it.each([
    ['today', '2026-11-13'],
    ['30d', '2026-10-15'],
    ['90d', '2026-08-16'],
  ])('sets the %s preset ending today and drops the older range param', (id, from) => {
    const onChange = vi.fn();
    render(<StatusFilters search={{ product: 'product-a', range: '30d' }} facets={facets} onChange={onChange} />, {
      wrapper: QaTestWrapper,
    });
    fireEvent.click(screen.getByTestId(`qa-filter-preset-${id}`));
    expect(onChange).toHaveBeenCalledWith({ from, to: '2026-11-13', range: undefined });
  });

  it('presses no preset for a custom range', () => {
    render(
      <StatusFilters
        search={{ product: 'product-a', from: '2026-11-01', to: '2026-11-10' }}
        facets={facets}
        onChange={vi.fn()}
      />,
      { wrapper: QaTestWrapper }
    );
    for (const id of ['today', '7d', '30d', '90d']) {
      expect(screen.getByTestId(`qa-filter-preset-${id}`)).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('picks a start and end date, moving the other end when they cross', () => {
    const onChange = vi.fn();
    const search = { product: 'product-a', from: '2026-11-01', to: '2026-11-10' };
    render(<StatusFilters search={search} facets={facets} onChange={onChange} />, { wrapper: QaTestWrapper });
    fireEvent.change(dateInput('qa-filter-from'), { target: { value: '2026-10-20' } });
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-10-20', to: '2026-11-10', range: undefined });
    fireEvent.change(dateInput('qa-filter-from'), { target: { value: '2026-11-12' } });
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-12', to: '2026-11-12', range: undefined });
    fireEvent.change(dateInput('qa-filter-to'), { target: { value: '2026-10-25' } });
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-10-25', to: '2026-10-25', range: undefined });
  });

  it('clamps a typed future date to today on either end', () => {
    const onChange = vi.fn();
    const search = { product: 'product-a', from: '2026-11-01', to: '2026-11-10' };
    render(<StatusFilters search={search} facets={facets} onChange={onChange} />, { wrapper: QaTestWrapper });
    fireEvent.change(dateInput('qa-filter-to'), { target: { value: '2026-12-26' } });
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-01', to: '2026-11-13', range: undefined });
    fireEvent.change(dateInput('qa-filter-from'), { target: { value: '2026-11-25' } });
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-11-13', to: '2026-11-13', range: undefined });
  });

  it('ignores a cleared date', () => {
    const onChange = vi.fn();
    render(<StatusFilters search={{ product: 'product-a' }} facets={facets} onChange={onChange} />, {
      wrapper: QaTestWrapper,
    });
    fireEvent.change(dateInput('qa-filter-to'), { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
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

import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import ProductAccess from './ProductAccess';
import type { IUserDocument } from '@bike4mind/common';

const mockProductAccess = vi.fn();
const mockMutate = vi.fn();
const mockInvalidate = vi.fn();

vi.mock('@client/app/hooks/data/entitlements', async () => {
  const actual = await vi.importActual<object>('@client/app/hooks/data/entitlements');
  return {
    ...actual,
    useGetUserProductAccess: () => mockProductAccess(),
  };
});

vi.mock('@client/app/hooks/data/user', () => ({
  useUpdateUser: () => ({ mutate: mockMutate, isPending: false }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<object>('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
  };
});

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => {
  const queryClient = new QueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
};

const USER = { id: 'u1', tags: ['opti'], isAdmin: false } as IUserDocument;

beforeEach(() => {
  mockProductAccess.mockReset();
  mockMutate.mockReset();
  mockInvalidate.mockReset();
});

describe('ProductAccess', () => {
  it('shows a loading indicator while fetching', () => {
    mockProductAccess.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(<ProductAccess user={USER} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('product-access-loading')).toBeInTheDocument();
  });

  it('shows an error message on fetch failure', () => {
    mockProductAccess.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    render(<ProductAccess user={USER} />, { wrapper: TestWrapper });
    expect(screen.getByText('Failed to load product access')).toBeInTheDocument();
  });

  it('renders a held key with its source and a Revoke button', () => {
    mockProductAccess.mockReturnValue({
      data: {
        entitlements: [
          { key: 'optihashi:pro', held: true, grantTag: 'opti', sources: [{ type: 'tag', detail: 'opti' }] },
        ],
      },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={USER} />, { wrapper: TestWrapper });
    expect(screen.getByText('optihashi:pro')).toBeInTheDocument();
    expect(screen.getByText('Held')).toBeInTheDocument();
    expect(screen.getByTestId('product-access-toggle-optihashi:pro')).toHaveTextContent('Revoke (opti)');
  });

  it('renders an unheld key with a Grant button and no source chips', () => {
    mockProductAccess.mockReturnValue({
      data: { entitlements: [{ key: 'optihashi:compute', held: false, grantTag: 'opti-compute', sources: [] }] },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={USER} />, { wrapper: TestWrapper });
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.getByTestId('product-access-toggle-optihashi:compute')).toHaveTextContent('Grant (opti-compute)');
  });

  it('clicking Grant adds the comp tag and invalidates the product-access query', () => {
    mockProductAccess.mockReturnValue({
      data: { entitlements: [{ key: 'optihashi:compute', held: false, grantTag: 'opti-compute', sources: [] }] },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={USER} />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('product-access-toggle-optihashi:compute'));

    expect(mockMutate).toHaveBeenCalledWith(
      { id: 'u1', data: { tags: ['opti', 'opti-compute'] } },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
    // Simulate the mutation's onSuccess firing, as react-query would.
    const [, options] = mockMutate.mock.calls[0];
    options.onSuccess();
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'user-entitlements', 'u1'] });
  });

  it('clicking Revoke removes the comp tag case-insensitively', () => {
    mockProductAccess.mockReturnValue({
      data: {
        entitlements: [
          { key: 'optihashi:pro', held: true, grantTag: 'opti', sources: [{ type: 'tag', detail: 'Opti' }] },
        ],
      },
      isLoading: false,
      error: null,
    });
    const legacyCasingUser = { ...USER, tags: ['Opti'] } as IUserDocument;
    render(<ProductAccess user={legacyCasingUser} />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('product-access-toggle-optihashi:pro'));
    expect(mockMutate).toHaveBeenCalledWith(
      { id: 'u1', data: { tags: [] } },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('warns when a tag grant is redundant with another source, since revoking the tag alone will not remove access', () => {
    mockProductAccess.mockReturnValue({
      data: {
        entitlements: [
          {
            key: 'optihashi:pro',
            held: true,
            grantTag: 'opti',
            sources: [
              { type: 'tag', detail: 'opti' },
              { type: 'domain', detail: 'partner.example' },
            ],
          },
        ],
      },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={USER} />, { wrapper: TestWrapper });
    expect(screen.getByText(/Also granted via Email domain/)).toBeInTheDocument();
  });

  it('shows a read-only note (no grant control) for a key with no tag-based grant path', () => {
    mockProductAccess.mockReturnValue({
      data: { entitlements: [{ key: 'libreoncology:pro', held: false, grantTag: undefined, sources: [] }] },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={USER} />, { wrapper: TestWrapper });
    expect(screen.getByText(/No tag-based grant for this product/)).toBeInTheDocument();
    expect(screen.queryByTestId('product-access-toggle-libreoncology:pro')).not.toBeInTheDocument();
  });
});

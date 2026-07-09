import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ProductAccess from './ProductAccess';
import type { IUserDocument } from '@bike4mind/common';

const mockProductAccess = vi.fn();

vi.mock('@client/app/hooks/data/entitlements', async () => {
  const actual = await vi.importActual<object>('@client/app/hooks/data/entitlements');
  return {
    ...actual,
    useGetUserProductAccess: () => mockProductAccess(),
  };
});

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const makeUser = (tags: string[] = []): IUserDocument => ({ id: 'u1', tags, isAdmin: false }) as IUserDocument;

beforeEach(() => {
  mockProductAccess.mockReset();
});

describe('ProductAccess', () => {
  it('shows a loading indicator while fetching', () => {
    mockProductAccess.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(<ProductAccess user={makeUser()} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('product-access-loading')).toBeInTheDocument();
  });

  it('shows an error message on fetch failure', () => {
    mockProductAccess.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    render(<ProductAccess user={makeUser()} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });
    expect(screen.getByText('Failed to load product access')).toBeInTheDocument();
  });

  it('derives Held + a Revoke button from the LIVE user tags, not the server row sources', () => {
    // Server resolver hasn't caught up (row.sources empty), but the live formState has the tag:
    // the panel must reflect the live grant immediately.
    mockProductAccess.mockReturnValue({
      data: { entitlements: [{ key: 'optihashi:pro', held: false, grantTag: 'opti', sources: [] }] },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={makeUser(['opti'])} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });
    expect(screen.getByText('Held')).toBeInTheDocument();
    expect(screen.getByTestId('product-access-toggle-optihashi:pro')).toHaveTextContent('Revoke (opti)');
  });

  it('shows Grant + None when the live user lacks the grant tag', () => {
    mockProductAccess.mockReturnValue({
      data: { entitlements: [{ key: 'optihashi:compute', held: false, grantTag: 'opti-compute', sources: [] }] },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={makeUser([])} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.getByTestId('product-access-toggle-optihashi:compute')).toHaveTextContent('Grant (opti-compute)');
  });

  it('staging a Grant calls onFieldChange with the tag appended (single batched-save source of truth)', () => {
    const onFieldChange = vi.fn();
    mockProductAccess.mockReturnValue({
      data: { entitlements: [{ key: 'optihashi:compute', held: false, grantTag: 'opti-compute', sources: [] }] },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={makeUser(['existing-tag'])} onFieldChange={onFieldChange} />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('product-access-toggle-optihashi:compute'));
    expect(onFieldChange).toHaveBeenCalledWith('tags', ['existing-tag', 'opti-compute']);
  });

  it('staging a Revoke removes the tag case-insensitively', () => {
    const onFieldChange = vi.fn();
    mockProductAccess.mockReturnValue({
      data: { entitlements: [{ key: 'optihashi:pro', held: true, grantTag: 'opti', sources: [] }] },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={makeUser(['Opti', 'keep-me'])} onFieldChange={onFieldChange} />, {
      wrapper: TestWrapper,
    });
    fireEvent.click(screen.getByTestId('product-access-toggle-optihashi:pro'));
    expect(onFieldChange).toHaveBeenCalledWith('tags', ['keep-me']);
  });

  it('does NOT write a duplicate when the user already has the grant tag in a different casing', () => {
    const onFieldChange = vi.fn();
    // Server row shows not-granted (stale), but the live user already has 'Opti'. The live
    // derivation renders Revoke, so clicking removes it - the duplicate-add path is never reached.
    mockProductAccess.mockReturnValue({
      data: { entitlements: [{ key: 'optihashi:pro', held: false, grantTag: 'opti', sources: [] }] },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={makeUser(['Opti'])} onFieldChange={onFieldChange} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('product-access-toggle-optihashi:pro')).toHaveTextContent('Revoke (opti)');
    fireEvent.click(screen.getByTestId('product-access-toggle-optihashi:pro'));
    expect(onFieldChange).toHaveBeenCalledWith('tags', []);
  });

  it('renders read-only non-tag sources (domain / subscription / bypass) as chips', () => {
    mockProductAccess.mockReturnValue({
      data: {
        entitlements: [
          {
            key: 'optihashi:pro',
            held: true,
            grantTag: 'opti',
            sources: [
              { type: 'domain', detail: 'partner.example' },
              { type: 'admin-bypass', detail: 'Super Admin' },
            ],
          },
        ],
      },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={makeUser([])} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });
    // Held via a non-tag source even though the live user has no grant tag.
    expect(screen.getByText('Held')).toBeInTheDocument();
    expect(screen.getByText('Email domain')).toBeInTheDocument();
    expect(screen.getByText('Super Admin')).toBeInTheDocument();
    // No tag grant on the live user -> button offers to Grant.
    expect(screen.getByTestId('product-access-toggle-optihashi:pro')).toHaveTextContent('Grant (opti)');
  });

  it('warns when a live tag grant is redundant with another (read-only) source', () => {
    mockProductAccess.mockReturnValue({
      data: {
        entitlements: [
          {
            key: 'optihashi:pro',
            held: true,
            grantTag: 'opti',
            sources: [{ type: 'domain', detail: 'partner.example' }],
          },
        ],
      },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={makeUser(['opti'])} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });
    expect(screen.getByText(/Also granted via Email domain/)).toBeInTheDocument();
  });

  it('shows a read-only note (no grant control) for a key with no tag-based grant path', () => {
    mockProductAccess.mockReturnValue({
      data: { entitlements: [{ key: 'libreoncology:pro', held: false, grantTag: undefined, sources: [] }] },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={makeUser([])} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });
    expect(screen.getByText(/No tag-based grant for this product/)).toBeInTheDocument();
    expect(screen.queryByTestId('product-access-toggle-libreoncology:pro')).not.toBeInTheDocument();
  });
});

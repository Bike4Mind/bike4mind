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
      data: { entitlements: [{ key: 'optihashi:pro', held: false, grantTag: 'opti', sources: [] }] },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={makeUser([])} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.getByTestId('product-access-toggle-optihashi:pro')).toHaveTextContent('Grant (opti)');
  });

  it('staging a Grant calls onFieldChange with the tag appended (single batched-save source of truth)', () => {
    const onFieldChange = vi.fn();
    mockProductAccess.mockReturnValue({
      data: { entitlements: [{ key: 'optihashi:pro', held: false, grantTag: 'opti', sources: [] }] },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={makeUser(['existing-tag'])} onFieldChange={onFieldChange} />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('product-access-toggle-optihashi:pro'));
    expect(onFieldChange).toHaveBeenCalledWith('tags', ['existing-tag', 'opti']);
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

  it('counts a 1:1 key-name tag as a live source, not only the mapped grant tag', () => {
    // A user tagged with the key name itself (`optihashi:pro`) holds the key through the
    // 1:1 pass-through even though the comp grant tag (`opti`) is absent; the panel must
    // show it as held with a Tag source, and the implied row must follow from it.
    mockProductAccess.mockReturnValue({
      data: {
        entitlements: [
          { key: 'optihashi:pro', held: true, grantTag: 'opti', sources: [{ type: 'tag', detail: 'optihashi:pro' }] },
          {
            key: 'questmaster:pro',
            held: true,
            grantTag: 'questmaster-pro',
            sources: [{ type: 'implied', detail: 'optihashi:pro' }],
          },
        ],
      },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={makeUser(['optihashi:pro'])} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('product-access-source-optihashi:pro-tag')).toHaveTextContent('Tag');
    expect(screen.getByTestId('product-access-source-questmaster:pro-implied')).toHaveTextContent('Implied');
    expect(screen.getAllByText('Held')).toHaveLength(2);
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

  it('warns that revoking the comp tag will not remove access when a second tag also grants the key', () => {
    mockProductAccess.mockReturnValue({
      data: { entitlements: [{ key: 'optihashi:pro', held: true, grantTag: 'opti', sources: [] }] },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={makeUser(['opti', 'optihashi:pro'])} onFieldChange={vi.fn()} />, {
      wrapper: TestWrapper,
    });
    // The button removes only the comp tag; the 1:1 tag keeps the row held, so say so.
    expect(screen.getByTestId('product-access-toggle-optihashi:pro')).toHaveTextContent('Revoke (opti)');
    expect(
      screen.getByText(/Also granted via tag optihashi:pro - revoking the opti tag alone will not remove access/)
    ).toBeInTheDocument();
  });

  it('reads Held via the 1:1 tag with a Grant button and no revoke-only warning', () => {
    const onFieldChange = vi.fn();
    mockProductAccess.mockReturnValue({
      data: { entitlements: [{ key: 'optihashi:pro', held: true, grantTag: 'opti', sources: [] }] },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={makeUser(['optihashi:pro'])} onFieldChange={onFieldChange} />, {
      wrapper: TestWrapper,
    });
    // No comp tag -> the button offers to add it, and nothing claims revoking a tag is the remedy.
    expect(screen.getByTestId('product-access-toggle-optihashi:pro')).toHaveTextContent('Grant (opti)');
    expect(screen.queryByText(/revoking the/)).not.toBeInTheDocument();
    expect(screen.getByTestId('product-access-tag-hint-optihashi:pro')).toHaveTextContent(
      'Held via tag optihashi:pro.'
    );
    expect(screen.getByText('Held')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('product-access-toggle-optihashi:pro'));
    expect(onFieldChange).toHaveBeenCalledWith('tags', ['optihashi:pro', 'opti']);
  });

  it('disambiguates the source-chip testid when two tags grant the same key', () => {
    mockProductAccess.mockReturnValue({
      data: { entitlements: [{ key: 'optihashi:pro', held: true, grantTag: 'opti', sources: [] }] },
      isLoading: false,
      error: null,
    });
    render(<ProductAccess user={makeUser(['opti', 'optihashi:pro'])} onFieldChange={vi.fn()} />, {
      wrapper: TestWrapper,
    });
    expect(screen.getByTestId('product-access-source-optihashi:pro-tag')).toHaveTextContent('Tag');
    expect(screen.getByTestId('product-access-source-optihashi:pro-tag-2')).toHaveTextContent('Tag');
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
  describe('implied entitlements (computed live from the held set)', () => {
    const rows = (questmasterSources: { type: string; detail: string }[] = []) => ({
      data: {
        entitlements: [
          { key: 'optihashi:pro', held: true, grantTag: 'opti', sources: [{ type: 'tag', detail: 'opti' }] },
          { key: 'questmaster:pro', held: true, grantTag: 'questmaster-pro', sources: questmasterSources },
        ],
      },
      isLoading: false,
      error: null,
    });

    it('renders the Implied chip and an implied-only hint, with no Revoke for the implied key', () => {
      // The server's own `implied` source is ignored in favor of the live computation.
      mockProductAccess.mockReturnValue(rows([{ type: 'implied', detail: 'optihashi:pro' }]));
      render(<ProductAccess user={makeUser(['opti'])} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });
      expect(screen.getByTestId('product-access-source-questmaster:pro-implied')).toHaveTextContent('Implied');
      expect(screen.getByTestId('product-access-implied-hint-questmaster:pro')).toHaveTextContent(
        'Implied by optihashi:pro - revoke that to remove.'
      );
      expect(screen.getByTestId('product-access-toggle-questmaster:pro')).toHaveTextContent('Grant (questmaster-pro)');
      expect(screen.getAllByText('Held')).toHaveLength(2);
    });

    it('drops the implied hold as soon as the implying tag revoke is staged (before Save)', () => {
      // Server still reports the SAVED state (opti tag + implied questmaster); the live user no
      // longer has the opti tag.
      mockProductAccess.mockReturnValue(rows([{ type: 'implied', detail: 'optihashi:pro' }]));
      const { rerender } = render(<ProductAccess user={makeUser(['opti'])} onFieldChange={vi.fn()} />, {
        wrapper: TestWrapper,
      });
      expect(screen.getByTestId('product-access-source-questmaster:pro-implied')).toBeInTheDocument();

      rerender(<ProductAccess user={makeUser([])} onFieldChange={vi.fn()} />);
      expect(screen.queryByTestId('product-access-source-questmaster:pro-implied')).not.toBeInTheDocument();
      expect(screen.queryByTestId('product-access-implied-hint-questmaster:pro')).not.toBeInTheDocument();
      expect(screen.getAllByText('None')).toHaveLength(2);
    });

    it('shows a staged grant of the implying tag as an implied hold immediately', () => {
      mockProductAccess.mockReturnValue({
        data: {
          entitlements: [
            { key: 'optihashi:pro', held: false, grantTag: 'opti', sources: [] },
            { key: 'questmaster:pro', held: false, grantTag: 'questmaster-pro', sources: [] },
          ],
        },
        isLoading: false,
        error: null,
      });
      render(<ProductAccess user={makeUser(['opti'])} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });
      expect(screen.getByTestId('product-access-source-questmaster:pro-implied')).toBeInTheDocument();
    });

    it('keeps the implied hold when the implying key is held by a non-tag source', () => {
      mockProductAccess.mockReturnValue({
        data: {
          entitlements: [
            {
              key: 'optihashi:pro',
              held: true,
              grantTag: 'opti',
              sources: [{ type: 'domain', detail: 'partner.example' }],
            },
            { key: 'questmaster:pro', held: true, grantTag: 'questmaster-pro', sources: [] },
          ],
        },
        isLoading: false,
        error: null,
      });
      render(<ProductAccess user={makeUser([])} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });
      expect(screen.getByTestId('product-access-source-questmaster:pro-implied')).toBeInTheDocument();
    });

    it('does not imply from a bypass-only hold', () => {
      mockProductAccess.mockReturnValue({
        data: {
          entitlements: [
            {
              key: 'optihashi:pro',
              held: true,
              grantTag: 'opti',
              sources: [{ type: 'admin-bypass', detail: 'Super Admin' }],
            },
            {
              key: 'questmaster:pro',
              held: true,
              grantTag: 'questmaster-pro',
              sources: [{ type: 'admin-bypass', detail: 'Super Admin' }],
            },
          ],
        },
        isLoading: false,
        error: null,
      });
      render(<ProductAccess user={makeUser([])} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });
      expect(screen.queryByTestId('product-access-source-questmaster:pro-implied')).not.toBeInTheDocument();
    });

    it('warns that revoking the questmaster-pro tag alone will not remove an implied hold', () => {
      mockProductAccess.mockReturnValue(rows());
      render(<ProductAccess user={makeUser(['opti', 'questmaster-pro'])} onFieldChange={vi.fn()} />, {
        wrapper: TestWrapper,
      });
      expect(screen.getByText(/Also granted via Implied/)).toBeInTheDocument();
      expect(screen.queryByTestId('product-access-implied-hint-questmaster:pro')).not.toBeInTheDocument();
    });
  });
});

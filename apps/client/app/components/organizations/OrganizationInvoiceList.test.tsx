import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { OrgInvoice } from '@client/app/utils/orgInvoices';
import OrganizationInvoiceList from './OrganizationInvoiceList';

const mockUseOrgInvoices = vi.fn();
vi.mock('@client/app/hooks/data/useOrgInvoices', () => ({
  useOrgInvoices: (orgId: string) => mockUseOrgInvoices(orgId),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderList = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <OrganizationInvoiceList organizationId="o1" />
    </CssVarsProvider>
  );

const invoice = (overrides: Partial<OrgInvoice> = {}): OrgInvoice => ({
  id: 'in_1',
  number: 'ABC-0001',
  createdAt: '2026-03-04T12:00:00.000Z',
  amountDue: 4_900,
  amountPaid: 4_900,
  currency: 'usd',
  status: 'paid',
  hostedInvoiceUrl: 'https://invoice.stripe.com/i/in_1',
  invoicePdf: 'https://pay.stripe.com/invoice/in_1/pdf',
  ...overrides,
});

const loaded = (invoices: OrgInvoice[], hasMore = false) =>
  mockUseOrgInvoices.mockReturnValue({ isLoading: false, isError: false, data: { invoices, hasMore } });

beforeEach(() => {
  mockUseOrgInvoices.mockReset();
});

describe('OrganizationInvoiceList', () => {
  it('shows each invoice with its date, number, amount, status and links', () => {
    loaded([invoice()]);

    renderList();

    expect(mockUseOrgInvoices).toHaveBeenCalledWith('o1');
    const [row] = screen.getAllByTestId('org-invoices-row');
    expect(row.textContent).toContain('Mar 4, 2026');
    expect(row.textContent).toContain('ABC-0001');
    expect(screen.getByTestId('org-invoices-amount').textContent).toBe('$49.00');
    expect(screen.getByTestId('org-invoices-status').textContent).toBe('Paid');
    const view = screen.getByTestId('org-invoices-view-link');
    expect(view.getAttribute('href')).toBe('https://invoice.stripe.com/i/in_1');
    expect(view.getAttribute('target')).toBe('_blank');
    expect(view.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByTestId('org-invoices-pdf-link').getAttribute('href')).toBe(
      'https://pay.stripe.com/invoice/in_1/pdf'
    );
    expect(screen.queryByTestId('org-invoices-more')).toBeNull();
  });

  it('shows what is owed on an open invoice and falls back to the id without a number', () => {
    loaded([invoice({ status: 'open', number: null, amountDue: 12_000, amountPaid: 0 })]);

    renderList();

    expect(screen.getByTestId('org-invoices-row').textContent).toContain('in_1');
    expect(screen.getByTestId('org-invoices-amount').textContent).toBe('$120.00');
    expect(screen.getByTestId('org-invoices-status').textContent).toBe('Open');
  });

  it('omits links Stripe did not provide', () => {
    loaded([invoice({ status: 'void', hostedInvoiceUrl: null, invoicePdf: null })]);

    renderList();

    expect(screen.queryByTestId('org-invoices-view-link')).toBeNull();
    expect(screen.queryByTestId('org-invoices-pdf-link')).toBeNull();
    expect(screen.getByTestId('org-invoices-status').textContent).toBe('Void');
  });

  it('points to the Billing Portal when more invoices exist', () => {
    loaded([invoice(), invoice({ id: 'in_2' })], true);

    renderList();

    expect(screen.getAllByTestId('org-invoices-row')).toHaveLength(2);
    expect(screen.getByTestId('org-invoices-more').textContent).toBe(
      'Showing the 2 most recent invoices. The Billing Portal has the full history.'
    );
  });

  it('says so when there are no invoices', () => {
    loaded([]);

    renderList();

    expect(screen.getByTestId('org-invoices-empty')).toBeTruthy();
  });

  it('offers a retry when the request fails', () => {
    const refetch = vi.fn();
    mockUseOrgInvoices.mockReturnValue({ isLoading: false, isError: true, data: undefined, refetch });

    renderList();
    screen.getByTestId('org-invoices-retry-btn').click();

    expect(refetch).toHaveBeenCalled();
  });
});

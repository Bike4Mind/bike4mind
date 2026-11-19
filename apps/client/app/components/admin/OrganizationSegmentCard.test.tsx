import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IOrganizationDocument, WithId } from '@bike4mind/common';
import { toast } from 'sonner';
import OrganizationSegmentCard from './OrganizationSegmentCard';

const setOrganizationAccountSegment = vi.fn();

vi.mock('@client/app/utils/organizationAPICalls', () => ({
  setOrganizationAccountSegment: (...args: unknown[]) => setOrganizationAccountSegment(...args),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderCard = (org: WithId<IOrganizationDocument>) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  render(<OrganizationSegmentCard org={org} />, { wrapper: Wrapper });
  return { invalidate };
};

const makeOrg = (overrides: Partial<IOrganizationDocument> = {}): WithId<IOrganizationDocument> =>
  ({ id: 'org1', name: 'Acme', personal: false, ...overrides }) as WithId<IOrganizationDocument>;

describe('OrganizationSegmentCard', () => {
  beforeEach(() => {
    setOrganizationAccountSegment.mockReset();
    setOrganizationAccountSegment.mockResolvedValue({ accountSegment: 'partner' });
  });

  it('reads an absent segment as customer', () => {
    renderCard(makeOrg());
    expect(screen.getByTestId('org-segment-select')).toHaveTextContent('Customer');
  });

  it('shows the stored segment', () => {
    renderCard(makeOrg({ accountSegment: 'internal' }));
    expect(screen.getByTestId('org-segment-select')).toHaveTextContent('Internal');
  });

  it('saves a new segment only after a reason is chosen, then refreshes the org queries', async () => {
    const { invalidate } = renderCard(makeOrg());

    fireEvent.click(screen.getByTestId('org-segment-select'));
    fireEvent.click(await screen.findByTestId('org-segment-option-partner'));

    expect(setOrganizationAccountSegment).not.toHaveBeenCalled();
    expect(screen.getByTestId('org-segment-action-dialog-confirm-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('org-segment-action-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('org-segment-action-dialog-confirm-btn'));

    await waitFor(() =>
      expect(setOrganizationAccountSegment).toHaveBeenCalledWith('org1', 'partner', 'Pilot or partner access')
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['organizations'] }));
    await waitFor(() => expect(screen.getByTestId('org-segment-select')).toHaveTextContent('Partner'));
  });

  it('toasts the error and keeps the saved segment when the save fails', async () => {
    setOrganizationAccountSegment.mockRejectedValue(new Error('Reason is required'));
    renderCard(makeOrg());

    fireEvent.click(screen.getByTestId('org-segment-select'));
    fireEvent.click(await screen.findByTestId('org-segment-option-partner'));
    fireEvent.click(screen.getByTestId('org-segment-action-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('org-segment-action-dialog-confirm-btn'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Reason is required'));
    expect(screen.getByTestId('org-segment-select')).toHaveTextContent('Customer');
  });
});

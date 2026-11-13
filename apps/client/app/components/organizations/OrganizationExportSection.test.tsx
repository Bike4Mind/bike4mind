import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import OrganizationExportSection from './OrganizationExportSection';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: h }));
const theme = extendTheme({ ...getThemeConfig() });
const renderSection = () =>
  render(
    <CssVarsProvider theme={theme}>
      <OrganizationExportSection organizationId="org" />
    </CssVarsProvider>
  );
beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.get.mockResolvedValue({ data: { exportJobId: null } });
  h.post.mockResolvedValue({ data: { exportJobId: 'job' } });
});
describe('organization export panel', () => {
  it('requests a background export and displays the completed download action', async () => {
    renderSection();
    await waitFor(() => expect(h.get).toHaveBeenCalled());
    h.get.mockResolvedValue({ data: { status: 'ready' } });
    fireEvent.click(screen.getByTestId('organization-export-request-btn'));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/api/organizations/org/data-export'));
    expect(await screen.findByTestId('organization-export-download-btn')).toBeTruthy();
    expect(screen.getByText(/Projects, notebooks, files, and credentials are not included/)).toBeTruthy();
  });
  it('recovers pending jobs and disables duplicate requests', async () => {
    h.get.mockResolvedValueOnce({ data: { exportJobId: 'job' } }).mockResolvedValue({ data: { status: 'pending' } });
    const view = renderSection();
    await screen.findByText('Preparing your export...');
    expect((screen.getByTestId('organization-export-request-btn') as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
  });
  it('shows expired exports and allows a new request', async () => {
    h.get.mockResolvedValueOnce({ data: { exportJobId: 'job' } }).mockResolvedValue({ data: { status: 'expired' } });
    renderSection();
    await screen.findByText('Export expired. Request a new export.');
    expect((screen.getByTestId('organization-export-request-btn') as HTMLButtonElement).disabled).toBe(false);
  });
  it('shows request failures without a download action', async () => {
    h.post.mockRejectedValue(new Error('rate limited'));
    renderSection();
    fireEvent.click(screen.getByTestId('organization-export-request-btn'));
    await screen.findByText(/Could not load or request/);
    expect(screen.queryByTestId('organization-export-download-btn')).toBeNull();
  });
});

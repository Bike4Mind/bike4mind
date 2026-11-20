import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { foreverRetention, type IOrganizationDocument } from '@bike4mind/common';
import OrganizationRetentionSection from './OrganizationRetentionSection';

const h = vi.hoisted(() => ({ user: { id: 'owner' }, post: vi.fn(), put: vi.fn(), invalidate: vi.fn() }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: h.user }) }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: h.post, put: h.put } }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { policy: { chats: null, files: null, media: null }, version: 0 } }),
  useQueryClient: () => ({ invalidateQueries: h.invalidate }),
}));
const theme = extendTheme({ ...getThemeConfig() });
const org = {
  id: 'org',
  userId: 'owner',
  personal: false,
  users: [],
  retentionPolicy: foreverRetention,
} as unknown as IOrganizationDocument;
function panel() {
  return render(
    <CssVarsProvider theme={theme}>
      <OrganizationRetentionSection organization={org} />
    </CssVarsProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: 'owner' };
  h.post.mockResolvedValue({ data: { token: 'server-token', counts: { chats: 4, files: 2, media: 1 } } });
  h.put.mockResolvedValue({ data: {} });
});
describe('organization retention', () => {
  it('shows all three active policies to ordinary members without edit controls', () => {
    h.user = { id: 'member' };
    panel();
    expect(screen.getByTestId('organization-retention-section').textContent).toContain('Chat history: Keep forever');
    expect(screen.getByTestId('organization-retention-section').textContent).toContain('Uploaded files: Keep forever');
    expect(screen.getByTestId('organization-retention-section').textContent).toContain('Generated media: Keep forever');
    expect(screen.queryByTestId('organization-retention-save-btn')).toBeNull();
  });
  it('requires an estimate followed by a separate confirmation before saving a shorter policy', async () => {
    panel();
    fireEvent.change(screen.getByTestId('organization-retention-chats-input'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('organization-retention-save-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('organization-retention-estimate').textContent).toContain('4 messages')
    );
    expect(h.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('organization-retention-save-btn'));
    await waitFor(() =>
      expect(h.put).toHaveBeenCalledWith('/api/organizations/org/retention', {
        policy: { chats: 30, files: null, media: null },
        version: 0,
        confirmationToken: 'server-token',
      })
    );
  });
  it('invalidates the confirmation when the draft changes', async () => {
    panel();
    fireEvent.change(screen.getByTestId('organization-retention-files-input'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('organization-retention-save-btn'));
    await screen.findByTestId('organization-retention-estimate');
    fireEvent.change(screen.getByTestId('organization-retention-files-input'), { target: { value: '10' } });
    expect(screen.queryByTestId('organization-retention-estimate')).toBeNull();
    expect(h.put).not.toHaveBeenCalled();
  });
  it('shows the error and no estimate when the estimate request fails', async () => {
    h.post.mockRejectedValue(new Error('boom'));
    panel();
    fireEvent.change(screen.getByTestId('organization-retention-chats-input'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('organization-retention-save-btn'));
    await screen.findByTestId('organization-retention-error');
    expect(screen.queryByTestId('organization-retention-estimate')).toBeNull();
    expect(h.put).not.toHaveBeenCalled();
  });
  it('shows the error and clears the estimate when saving fails', async () => {
    h.put.mockRejectedValue(new Error('conflict'));
    panel();
    fireEvent.change(screen.getByTestId('organization-retention-chats-input'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('organization-retention-save-btn'));
    await screen.findByTestId('organization-retention-estimate');
    fireEvent.click(screen.getByTestId('organization-retention-save-btn'));
    await screen.findByTestId('organization-retention-error');
    expect(screen.queryByTestId('organization-retention-estimate')).toBeNull();
  });
});

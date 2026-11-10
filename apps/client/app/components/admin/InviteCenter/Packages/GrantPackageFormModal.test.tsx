import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IGrantPackageDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { GrantPackageFormModal } from './GrantPackageFormModal';

const api = vi.hoisted(() => ({
  createGrantPackage: vi.fn(),
  updateGrantPackage: vi.fn(),
  fetchGrantPackageLinks: vi.fn(),
  createRegInvites: vi.fn(),
  updateRegInvite: vi.fn(),
}));
vi.mock('@client/app/utils/grantPackageAPICalls', () => ({
  createGrantPackage: api.createGrantPackage,
  updateGrantPackage: api.updateGrantPackage,
  fetchGrantPackageLinks: api.fetchGrantPackageLinks,
  grantPackageLinksQueryKey: (id: string) => ['admin-grant-packages', id, 'links'],
  GRANT_PACKAGES_QUERY_KEY: 'admin-grant-packages',
}));
vi.mock('@client/app/utils/regInviteAPICalls', () => ({
  createRegInvites: api.createRegInvites,
  updateRegInvite: api.updateRegInvite,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const policy = { singleGrantCredits: 50_000, dailyTotalCredits: 200_000 };
const pkg = {
  id: 'p1',
  name: 'Launch',
  credits: 100,
  totalCap: 10,
  dailyCap: null,
  redeemedTotal: 0,
  capHits: 0,
  active: true,
  createdBy: 'admin-1',
} as unknown as IGrantPackageDocument;
const links = (invites: unknown[] = []) => ({
  invites: { data: invites, truncated: false },
  partnerRules: { data: [], truncated: false },
});

const renderModal = (editing: IGrantPackageDocument | null) => {
  const props = { onClose: vi.fn(), onSaved: vi.fn() };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <GrantPackageFormModal open editing={editing} reasonPolicy={policy} {...props} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return props;
};
const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('GrantPackageFormModal invite codes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchGrantPackageLinks.mockResolvedValue(links());
    api.createGrantPackage.mockResolvedValue({ ...pkg, id: 'p2', name: 'Fresh' });
    api.updateGrantPackage.mockResolvedValue(pkg);
    api.createRegInvites.mockResolvedValue([{ code: 'NEW1' }]);
  });

  it('lists the codes linked to the package being edited', async () => {
    api.fetchGrantPackageLinks.mockResolvedValue(
      links([
        { id: 'i1', code: 'ALPHA', unlimitedUse: false },
        { id: 'i2', code: 'BETA', unlimitedUse: false, used: new Date('2026-01-01') },
      ])
    );
    renderModal(pkg);
    expect(await screen.findByTestId('grant-package-code-row-ALPHA')).toHaveTextContent('Active');
    expect(screen.getByTestId('grant-package-code-row-BETA')).toHaveTextContent('Inactive');
    expect(api.fetchGrantPackageLinks).toHaveBeenCalledWith('p1');
  });

  it('adds a code to the edited package straight away', async () => {
    renderModal(pkg);
    await screen.findByTestId('grant-package-codes-empty');
    fireEvent.click(screen.getByTestId('grant-package-code-unlimited-switch'));
    fireEvent.click(screen.getByTestId('grant-package-add-code-btn'));
    await waitFor(() =>
      expect(api.createRegInvites).toHaveBeenCalledWith({ multiple: 1, unlimitedUse: true, grantPackageId: 'p1' })
    );
    expect(api.updateGrantPackage).not.toHaveBeenCalled();
  });

  it('shows a failed add inline and keeps the form open', async () => {
    api.createRegInvites.mockRejectedValue(new Error('Grant package has expired'));
    const props = renderModal(pkg);
    await screen.findByTestId('grant-package-codes-empty');
    fireEvent.click(screen.getByTestId('grant-package-add-code-btn'));
    expect(await screen.findByTestId('grant-package-codes-error')).toHaveTextContent('Grant package has expired');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', { expiresAt: new Date('2020-01-01') }, 'expired'],
    ['inactive', { active: false }, 'inactive'],
  ])('disables adding codes to an %s package', async (_label, patch, copy) => {
    renderModal({ ...pkg, ...patch } as IGrantPackageDocument);
    expect(screen.getByTestId('grant-package-add-code-btn')).toBeDisabled();
    expect(screen.getByTestId('grant-package-codes-closed')).toHaveTextContent(copy);
  });

  it('creates the package first, then each queued code against it, then closes', async () => {
    const props = renderModal(null);
    type('grant-package-name-input', 'Fresh');
    type('grant-package-credits-input', '100');
    type('grant-package-total-cap-input', '10');
    fireEvent.click(screen.getByTestId('grant-package-add-code-btn'));
    fireEvent.click(screen.getByTestId('grant-package-code-unlimited-switch'));
    fireEvent.click(screen.getByTestId('grant-package-add-code-btn'));
    expect(api.createRegInvites).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('grant-package-save-btn'));

    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(api.createGrantPackage).toHaveBeenCalledTimes(1);
    expect(api.createRegInvites.mock.calls).toEqual([
      [{ multiple: 1, unlimitedUse: false, grantPackageId: 'p2' }],
      [{ multiple: 1, unlimitedUse: true, grantPackageId: 'p2' }],
    ]);
    expect(api.createGrantPackage.mock.invocationCallOrder[0]).toBeLessThan(
      api.createRegInvites.mock.invocationCallOrder[0]
    );
  });

  it('on a code failure keeps the form open on the saved package and says what was not created', async () => {
    api.createRegInvites.mockResolvedValueOnce([{ code: 'OK1' }]).mockRejectedValueOnce(new Error('boom'));
    const props = renderModal(null);
    type('grant-package-name-input', 'Fresh');
    type('grant-package-credits-input', '100');
    type('grant-package-total-cap-input', '10');
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByTestId('grant-package-add-code-btn'));
    fireEvent.click(screen.getByTestId('grant-package-save-btn'));

    expect(await screen.findByTestId('grant-package-form-error')).toHaveTextContent(
      'Created Fresh, but 2 of 3 codes were not created: boom'
    );
    expect(api.createRegInvites).toHaveBeenCalledTimes(2);
    expect(props.onSaved).toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('grant-package-save-btn')).toHaveTextContent('Save package');
    await waitFor(() => expect(api.fetchGrantPackageLinks).toHaveBeenCalledWith('p2'));

    fireEvent.click(screen.getByTestId('grant-package-save-btn'));
    await waitFor(() => expect(api.updateGrantPackage).toHaveBeenCalledWith('p2', expect.anything()));
    expect(api.createGrantPackage).toHaveBeenCalledTimes(1);
  });
});

describe('GrantPackageFormModal inline code edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchGrantPackageLinks.mockResolvedValue(
      links([{ id: 'i1', code: 'ALPHA', unlimitedUse: false, expiresAt: '2030-01-31T23:59:59.999Z' }])
    );
    api.updateRegInvite.mockResolvedValue([{ id: 'i1' }]);
  });

  it('prefills the code, saves unlimited use and a new expiry day, then closes the editor and refetches', async () => {
    const props = renderModal(pkg);
    fireEvent.click(await screen.findByTestId('grant-package-code-edit-btn-ALPHA'));
    expect(screen.getByTestId('grant-package-code-edit')).toHaveTextContent('Edit code ALPHA');
    expect(screen.getByTestId('grant-package-code-edit-expires-input')).toHaveValue('2030-01-31');

    fireEvent.click(screen.getByTestId('grant-package-code-edit-unlimited-switch'));
    type('grant-package-code-edit-expires-input', '2031-06-15');
    fireEvent.click(screen.getByTestId('grant-package-code-edit-save-btn'));

    await waitFor(() =>
      expect(api.updateRegInvite).toHaveBeenCalledWith('i1', {
        unlimitedUse: true,
        expiresAt: new Date('2031-06-15T23:59:59.999Z'),
      })
    );
    await waitFor(() => expect(screen.queryByTestId('grant-package-code-edit')).not.toBeInTheDocument());
    await waitFor(() => expect(api.fetchGrantPackageLinks).toHaveBeenCalledTimes(2));
    expect(api.updateGrantPackage).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('clears the expiry when the day is emptied', async () => {
    renderModal(pkg);
    fireEvent.click(await screen.findByTestId('grant-package-code-edit-btn-ALPHA'));
    type('grant-package-code-edit-expires-input', '');
    fireEvent.click(screen.getByTestId('grant-package-code-edit-save-btn'));
    await waitFor(() =>
      expect(api.updateRegInvite).toHaveBeenCalledWith('i1', { unlimitedUse: false, expiresAt: null })
    );
  });

  it('keeps the editor open and shows the error when the save fails', async () => {
    api.updateRegInvite.mockRejectedValue(new Error('Invalid invite id'));
    renderModal(pkg);
    fireEvent.click(await screen.findByTestId('grant-package-code-edit-btn-ALPHA'));
    fireEvent.click(screen.getByTestId('grant-package-code-edit-save-btn'));
    expect(await screen.findByTestId('grant-package-codes-error')).toHaveTextContent('Invalid invite id');
    expect(screen.getByTestId('grant-package-code-edit')).toBeInTheDocument();
  });

  it('discards the edit on cancel without saving', async () => {
    renderModal(pkg);
    fireEvent.click(await screen.findByTestId('grant-package-code-edit-btn-ALPHA'));
    fireEvent.click(screen.getByTestId('grant-package-code-edit-cancel-btn'));
    expect(screen.queryByTestId('grant-package-code-edit')).not.toBeInTheDocument();
    expect(api.updateRegInvite).not.toHaveBeenCalled();
  });
});

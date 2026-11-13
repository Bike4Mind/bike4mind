import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, WithId } from '@bike4mind/common';
import OrganizationGeneralSection from './OrganizationGeneralSection';

const update = vi.hoisted(() => vi.fn());
const upload = vi.hoisted(() => vi.fn());
const currentUser = vi.hoisted(() => ({ value: null as { id: string; isAdmin?: boolean } | null }));

vi.mock('@client/app/hooks/data/organizations', () => ({
  useUpdateOrganization: () => ({ mutateAsync: update, isPending: false }),
  useUploadOrganizationLogo: () => ({ mutateAsync: upload, isPending: false }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: currentUser.value }) }));
vi.mock('./OrganizationAvatar', () => ({ default: () => null }));
vi.mock('compressorjs', () => ({
  default: class {
    constructor(file: File, options: { success: (blob: Blob) => void }) {
      options.success(file);
    }
  },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const org = {
  id: 'org1',
  name: 'Acme',
  description: 'Rockets',
  billingContact: 'owner@acme.test',
  userId: 'owner1',
  adminUserIds: ['mgr1'],
  users: [
    { userId: 'mgr1', permissions: ['read', 'update'] },
    { userId: 'member1', permissions: ['read', 'update'] },
  ],
} as unknown as WithId<IOrganizationDocument>;

const renderAs = (user: { id: string; isAdmin?: boolean }) => {
  currentUser.value = user;
  return render(
    <CssVarsProvider theme={appTheme}>
      <OrganizationGeneralSection organization={org} />
    </CssVarsProvider>
  );
};

const input = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const saveButton = () => screen.getByTestId('organization-general-save-btn') as HTMLButtonElement;

describe('OrganizationGeneralSection', () => {
  beforeEach(() => {
    update.mockReset().mockResolvedValue({});
    upload.mockReset().mockResolvedValue('file1');
  });

  it('saves only the fields that changed, trimmed', async () => {
    renderAs({ id: 'owner1' });
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(input('organization-general-name-input'), { target: { value: '  Acme Labs ' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(update).toHaveBeenCalledWith({ orgId: 'org1', data: { name: 'Acme Labs' } }));
  });

  it('refuses an empty name', () => {
    renderAs({ id: 'owner1' });
    fireEvent.change(input('organization-general-name-input'), { target: { value: '   ' } });
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText('The team needs a name.')).toBeTruthy();
  });

  it('lets the owner change the billing contact, and only to an email', async () => {
    renderAs({ id: 'owner1' });
    const contact = input('organization-general-billing-contact-input');
    expect(contact.value).toBe('owner@acme.test');

    fireEvent.change(contact, { target: { value: 'not an email' } });
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(contact, { target: { value: 'billing@acme.test' } });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ orgId: 'org1', data: { billingContact: 'billing@acme.test' } })
    );
  });

  it('hides the billing contact from a manager, whose edit the server ignores', () => {
    renderAs({ id: 'mgr1' });
    expect(screen.queryByTestId('organization-general-billing-contact-input')).toBeNull();
    expect(screen.getByTestId('organization-general-logo-btn')).toBeTruthy();
  });

  it('hides the logo upload from a member the upload route refuses', () => {
    renderAs({ id: 'member1' });
    expect(screen.queryByTestId('organization-general-logo-btn')).toBeNull();
    expect(screen.getByTestId('organization-general-name-input')).toBeTruthy();
  });

  it('uploads a chosen logo, declaring the bytes it sends', async () => {
    renderAs({ id: 'owner1' });
    const file = new File(['png-bytes'], 'logo.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('organization-general-logo-input'), { target: { files: [file] } });

    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith({
        organizationId: 'org1',
        fileInfo: { fileName: 'logo.png', mimeType: 'image/png', fileSize: file.size },
        file,
      })
    );
  });

  it('does not upload a file type the logo route refuses', async () => {
    renderAs({ id: 'owner1' });
    const file = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' });
    fireEvent.change(screen.getByTestId('organization-general-logo-input'), { target: { files: [file] } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(upload).not.toHaveBeenCalled();
  });
});

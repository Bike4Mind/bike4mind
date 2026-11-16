import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { AxiosError, AxiosHeaders } from 'axios';
import { getThemeConfig } from '@client/app/utils/themes';
import type { BulkInviteResult } from '@client/app/hooks/data/organizations';
import BulkInviteModal, { summarizeBulkInvite } from './BulkInviteModal';

const mocks = vi.hoisted(() => ({
  mutation: {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null as unknown,
    data: undefined as unknown,
  },
}));

vi.mock('@client/app/hooks/data/organizations', () => ({
  useBulkInviteOrganization: () => mocks.mutation,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderModal = () =>
  render(<BulkInviteModal organizationId="org1" availableSeats={2} canGrantAdmin={false} onDone={vi.fn()} />, {
    wrapper: TestWrapper,
  });

const textarea = () => screen.getByTestId('org-bulk-invite-textarea') as HTMLTextAreaElement;
const submit = () => screen.getByTestId('org-bulk-invite-submit') as HTMLButtonElement;

const mixedResult: BulkInviteResult = {
  rows: [
    { email: 'new@x.com', raw: 'new@x.com', status: 'invite' },
    { email: 'member@x.com', raw: 'Member@x.com', status: 'already_member' },
    { email: 'nope', raw: 'nope', status: 'invalid' },
    { email: 'late@x.com', raw: 'late@x.com', status: 'seat_limit' },
  ],
  invitedCount: 1,
  inviteId: 'invite1',
};

describe('BulkInviteModal', () => {
  beforeEach(() => {
    mocks.mutation = { mutate: vi.fn(), isPending: false, isError: false, error: null, data: undefined };
  });

  it('keeps submit disabled until an address is entered', () => {
    renderModal();
    expect(submit().disabled).toBe(true);
    fireEvent.change(textarea(), { target: { value: '  \n ' } });
    expect(submit().disabled).toBe(true);
    fireEvent.change(textarea(), { target: { value: 'a@x.com, b@x.com' } });
    expect(submit().disabled).toBe(false);
  });

  it('sends the parsed addresses with the chosen role permissions', () => {
    renderModal();
    fireEvent.change(textarea(), { target: { value: 'a@x.com; b@x.com\nc@x.com' } });
    fireEvent.click(submit());
    expect(mocks.mutation.mutate).toHaveBeenCalledWith({
      organizationId: 'org1',
      emails: ['a@x.com', 'b@x.com', 'c@x.com'],
      permissions: ['read'],
    });
  });

  it('blocks more than 100 addresses with an inline error', () => {
    renderModal();
    const many = Array.from({ length: 101 }, (_, i) => `u${i}@x.com`).join('\n');
    fireEvent.change(textarea(), { target: { value: many } });
    expect(screen.getByTestId('org-bulk-invite-cap-error').textContent).toContain('remove 1');
    expect(submit().disabled).toBe(true);
  });

  it('fills the textarea from the first column of an uploaded CSV', async () => {
    renderModal();
    const file = new File(['\uFEFFemail,name\na@x.com,Ann\n\nb@x.com,Bob\n'], 'people.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByTestId('org-bulk-invite-file'), { target: { files: [file] } });
    await waitFor(() => expect(textarea().value).toBe('a@x.com\nb@x.com'));
  });

  it('renders one summary line and a status per row', () => {
    mocks.mutation.data = mixedResult;
    renderModal();
    expect(screen.getByTestId('org-bulk-invite-summary').textContent).toBe(
      '1 invited, 1 already in the team, 1 invalid, 1 over seat limit'
    );
    const labels = mixedResult.rows.map((_, i) => screen.getByTestId(`org-bulk-invite-row-${i}`).textContent);
    expect(labels).toEqual([
      'new@x.comInvited',
      'member@x.comAlready a member',
      'nopeInvalid address',
      'late@x.comOver seat limit',
    ]);
  });

  it('shows a rate-limit refusal as one alert and keeps the typed addresses', () => {
    mocks.mutation.isError = true;
    mocks.mutation.error = new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 429,
      statusText: 'Too Many Requests',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: { message: 'Too many invitations sent recently. Try again later.' },
    });
    renderModal();
    fireEvent.change(textarea(), { target: { value: 'a@x.com' } });
    expect(screen.getAllByTestId('org-bulk-invite-error')).toHaveLength(1);
    expect(screen.getByTestId('org-bulk-invite-error').textContent).toBe(
      'Too many invitations sent recently. Try again later.'
    );
    expect(screen.queryByTestId('org-bulk-invite-summary')).toBeNull();
    expect(textarea().value).toBe('a@x.com');
  });
});

describe('summarizeBulkInvite', () => {
  it('lists duplicates and already-invited rows only when present', () => {
    expect(
      summarizeBulkInvite({
        rows: [
          { email: 'a@x.com', raw: 'a@x.com', status: 'invite' },
          { email: 'a@x.com', raw: 'A@x.com', status: 'duplicate' },
          { email: 'p@x.com', raw: 'p@x.com', status: 'already_pending' },
        ],
        invitedCount: 1,
        inviteId: 'i',
      })
    ).toBe('1 invited, 1 already invited, 1 repeated in the list');
  });
});

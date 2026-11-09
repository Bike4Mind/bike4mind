import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { RegInviteStatusType } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { InviteTable } from './InviteTable';
import type { RegInviteData } from '../types';

vi.mock('../../../common/UsernameText', () => ({ default: ({ id }: { id: string }) => <span>{id}</span> }));

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;

const INVITES: RegInviteData[] = [
  { id: 'i1', code: 'ALPHA-1', userId: 'u1', status: RegInviteStatusType.open, createdAt: '2026-01-01T00:00:00.000Z' },
  {
    id: 'i2',
    code: 'BETA-2',
    userId: 'u1',
    status: RegInviteStatusType.waiting,
    createdAt: '2026-01-02T00:00:00.000Z',
  },
];

const setup = () => {
  const props = {
    allInvites: INVITES,
    selected: [] as string[],
    setSelected: vi.fn(),
    sortDirection: 'desc' as const,
    toggleSortDirection: vi.fn(),
    handleUpdate: vi.fn(),
    handleDelete: vi.fn(),
    copyToClipboard: vi.fn(),
    operating: false,
    copied: false,
    formatDate: (value: Date | string | undefined | null) => String(value ?? 'N/A'),
  };
  render(<InviteTable {...props} />, { wrapper: Wrapper });
  return props;
};

describe('InviteTable', () => {
  it('renders each invite as a table row with the e2e test ids', () => {
    setup();

    const rows = screen.getAllByTestId('invite-code-card');
    expect(rows).toHaveLength(2);
    expect(rows[0].tagName).toBe('TR');
    expect(within(rows[0]).getByTestId('invite-code-value')).toHaveTextContent('ALPHA-1');
  });

  it('copies a code and deletes through the row buttons', () => {
    const props = setup();
    const row = screen.getAllByTestId('invite-code-card')[1];

    fireEvent.click(within(row).getByTestId('invite-code-copy-btn'));
    expect(props.copyToClipboard).toHaveBeenCalledWith('BETA-2');
    fireEvent.click(within(row).getByTestId('delete-invite-code-btn'));
    expect(props.handleDelete).toHaveBeenCalledWith(['i2']);
  });

  it('changes status from the row menu', async () => {
    const props = setup();

    fireEvent.click(screen.getByTestId('invite-row-actions-i1'));
    fireEvent.click(await screen.findByTestId('invite-set-used-btn'));
    expect(props.handleUpdate).toHaveBeenCalledWith(['i1'], RegInviteStatusType.used);
  });

  it('maps row selection onto the selected ids', () => {
    const props = setup();

    fireEvent.click(within(screen.getByTestId('admin-table-select-i2')).getByRole('checkbox'));
    expect(props.setSelected).toHaveBeenCalledWith(['i2']);
  });

  it('shows the empty state when there are no invites', () => {
    render(
      <InviteTable
        allInvites={[]}
        selected={[]}
        setSelected={vi.fn()}
        sortDirection="desc"
        toggleSortDirection={vi.fn()}
        handleUpdate={vi.fn()}
        handleDelete={vi.fn()}
        copyToClipboard={vi.fn()}
        operating={false}
        copied={false}
        formatDate={String}
        empty={<div>nothing here</div>}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText('nothing here')).toBeInTheDocument();
  });
});

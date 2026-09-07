import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { WireDuplicateGroup } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  duplicates: vi.fn(),
}));

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetLakeMembershipDuplicates: (lakeId: string, enabled?: boolean) => h.duplicates(lakeId, enabled),
  useRecordMembershipDecision: () => ({ mutate: h.mutate, isPending: false }),
}));

import DuplicateAdmissionsChip, { DuplicateAdmissionDialog } from './DuplicateAdmissionDialog';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const group = (over: Partial<WireDuplicateGroup> = {}): WireDuplicateGroup => ({
  fileName: 'policy.md',
  bucket: 'differing',
  tier: 'fileName',
  memberCount: 2,
  members: [
    { fabFileId: 'new-1', fileSize: 2048, createdAt: new Date('2026-03-01T00:00:00Z'), arm: 'meta-tag' },
    { fabFileId: 'old-1', fileSize: 1024, createdAt: new Date('2026-01-01T00:00:00Z'), arm: 'meta-tag' },
  ],
  ...over,
});

const openWith = (groups: WireDuplicateGroup[], openGroupCount = groups.length) => ({
  data: { open: groups, openGroupCount, settledGroupCount: 0, stalledGroupCount: 0 },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.duplicates.mockReturnValue(openWith([group()]));
});

describe('DuplicateAdmissionDialog', () => {
  const renderDialog = (groups = [group()]) =>
    render(
      <TestWrapper>
        <DuplicateAdmissionDialog open onClose={vi.fn()} dataLakeId="lake-1" lakeName="Acme Policies" groups={groups} />
      </TestWrapper>
    );

  it('sends keep-newest for the group the owner acted on', () => {
    renderDialog();

    fireEvent.click(screen.getByTestId('datalake-duplicate-keepnewest-btn'));

    expect(h.mutate).toHaveBeenCalledWith({ dataLakeId: 'lake-1', fileName: 'policy.md', decision: 'keep-newest' });
  });

  it('sends keep-both, which records the ruling and removes nothing', () => {
    renderDialog();

    fireEvent.click(screen.getByTestId('datalake-duplicate-keepboth-btn'));

    expect(h.mutate).toHaveBeenCalledWith({ dataLakeId: 'lake-1', fileName: 'policy.md', decision: 'keep-both' });
  });

  it('sends NOTHING on cancel - not answering is not an answer', () => {
    const onClose = vi.fn();
    render(
      <TestWrapper>
        <DuplicateAdmissionDialog
          open
          onClose={onClose}
          dataLakeId="lake-1"
          lakeName="Acme Policies"
          groups={[group()]}
        />
      </TestWrapper>
    );

    fireEvent.click(screen.getByTestId('datalake-duplicate-cancel-btn'));

    expect(onClose).toHaveBeenCalled();
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it('names the tier that matched, since the weakest one can be wrong', () => {
    renderDialog([group({ tier: 'fileName' })]);
    expect(screen.getByText(/Matched by file name alone/)).toBeInTheDocument();

    renderDialog([group({ tier: 'driveFileId' })]);
    expect(screen.getByText(/same Drive document/)).toBeInTheDocument();
  });

  it('distinguishes a proven-identical pair from one whose copies differ', () => {
    renderDialog([group({ bucket: 'proven-identical' })]);
    expect(screen.getByText('Identical')).toBeInTheDocument();

    renderDialog([group({ bucket: 'differing' })]);
    expect(screen.getByText('Different content')).toBeInTheDocument();
  });

  it('reports the exact copy count even when the member list is capped', () => {
    // memberCount is exact and `members` is capped by the server, so the dialog must never imply
    // there are fewer copies than there are.
    renderDialog([group({ memberCount: 7 })]);

    expect(screen.getByText('7 copies')).toBeInTheDocument();
    expect(screen.getByText('+5 more')).toBeInTheDocument();
  });

  it('warns about a decision whose removal never finished, and stays quiet otherwise', () => {
    const { unmount } = render(
      <TestWrapper>
        <DuplicateAdmissionDialog
          open
          onClose={() => {}}
          dataLakeId="lake-1"
          lakeName="Acme Policies"
          groups={[group()]}
          stalledCount={2}
        />
      </TestWrapper>
    );

    expect(screen.getByTestId('datalake-duplicate-stalled')).toHaveTextContent('2 earlier decisions did not finish');
    unmount();

    renderDialog();
    expect(screen.queryByTestId('datalake-duplicate-stalled')).not.toBeInTheDocument();
  });
});

describe('DuplicateAdmissionsChip', () => {
  it('offers nothing to a principal who cannot manage the lake', () => {
    // The lake itself is readable by anyone it is shared with; resolving duplicates is not.
    h.duplicates.mockReturnValue(openWith([group()]));

    render(
      <TestWrapper>
        <DuplicateAdmissionsChip lakeId="lake-1" lakeName="Acme Policies" canManage={false} />
      </TestWrapper>
    );

    expect(screen.queryByTestId('datalake-duplicates-chip-lake-1')).not.toBeInTheDocument();
    // And it does not fetch either.
    expect(h.duplicates).toHaveBeenCalledWith('lake-1', false);
  });

  it('renders nothing when there is nothing to resolve', () => {
    h.duplicates.mockReturnValue(openWith([]));

    render(
      <TestWrapper>
        <DuplicateAdmissionsChip lakeId="lake-1" lakeName="Acme Policies" canManage />
      </TestWrapper>
    );

    expect(screen.queryByTestId('datalake-duplicates-chip-lake-1')).not.toBeInTheDocument();
  });

  it('renders nothing while the duplicates read has not loaded, rather than a zero chip', () => {
    h.duplicates.mockReturnValue({ data: undefined });

    render(
      <TestWrapper>
        <DuplicateAdmissionsChip lakeId="lake-1" lakeName="Acme Policies" canManage />
      </TestWrapper>
    );

    expect(screen.queryByTestId('datalake-duplicates-chip-lake-1')).not.toBeInTheDocument();
  });

  it('counts the OPEN groups the server reported, not the capped list it shipped', () => {
    // openGroupCount is exact while `open` is capped for payload size. A manager told "2 duplicates"
    // on a lake holding 60 would stop looking after the second.
    h.duplicates.mockReturnValue(openWith([group(), group({ fileName: 'other.md' })], 60));

    render(
      <TestWrapper>
        <DuplicateAdmissionsChip lakeId="lake-1" lakeName="Acme Policies" canManage />
      </TestWrapper>
    );

    expect(screen.getByTestId('datalake-duplicates-chip-lake-1')).toHaveTextContent('60 to resolve');
  });

  it('opens the dialog from the chip for a manager', () => {
    h.duplicates.mockReturnValue(openWith([group(), group({ fileName: 'other.md' })]));

    render(
      <TestWrapper>
        <DuplicateAdmissionsChip lakeId="lake-1" lakeName="Acme Policies" canManage />
      </TestWrapper>
    );

    const chip = screen.getByTestId('datalake-duplicates-chip-lake-1');
    expect(chip).toHaveTextContent('2 to resolve');

    // Joy renders a clickable Chip as an overlaid action BUTTON inside the chip root, and that is
    // what a real click lands on - firing on the root alone does not reach the handler.
    fireEvent.click(chip.querySelector('button')!);

    expect(screen.getByTestId('datalake-duplicate-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-duplicate-group-policy.md')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-duplicate-group-other.md')).toBeInTheDocument();
  });
});

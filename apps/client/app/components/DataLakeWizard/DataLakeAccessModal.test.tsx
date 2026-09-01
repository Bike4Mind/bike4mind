import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { LakeAccessView, LakeOwnershipCandidateList } from '@bike4mind/common';
import { DataLakeAccessModal } from './DataLakeAccessModal';

const downloadCsv = vi.fn();
let viewState: {
  data?: { view: LakeAccessView; canTransferOwnership: boolean };
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
};
let candidatesState: { data?: LakeOwnershipCandidateList; isLoading: boolean; isError?: boolean };
const transferMutate = vi.fn();

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useLakeAccessView: () => viewState,
  useLakeOwnershipCandidates: () => candidatesState,
  useTransferLakeOwnership: () => ({ mutateAsync: transferMutate, isPending: false }),
  downloadLakeAccessCsv: (...args: unknown[]) => downloadCsv(...args),
}));

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const fullView: LakeAccessView = {
  lakeId: 'lake1',
  lakeName: 'Sales Intelligence',
  grants: [
    {
      principalType: 'user',
      principalId: 'u2',
      principalName: 'Bob',
      role: 'reader',
      grantedByUserId: 'u1',
      grantedByName: 'Alice',
      grantedAt: new Date('2026-08-01T00:00:00.000Z'),
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      status: 'expired',
    },
  ],
  channels: [
    { kind: 'tag', value: 'vip' },
    { kind: 'organization', value: 'orgA', label: 'Acme', holderCount: 3 },
  ],
  history: [
    {
      principalKind: 'user',
      principalId: 'u2',
      principalName: 'Bob',
      readCount: 7,
      firstAccessedAt: new Date('2026-08-01T00:00:00.000Z'),
      lastAccessedAt: new Date('2026-08-10T00:00:00.000Z'),
      surfaces: ['chat-kb-search'],
    },
  ],
  historyTruncated: true,
  windowStartsAt: new Date('2026-08-01T00:00:00.000Z'),
  candidateCapPressure: {
    turnsWithSignal: 9,
    turnsAtCap: 4,
    lastAtCapAt: new Date('2026-08-10T00:00:00.000Z'),
  },
  generatedAt: new Date('2026-08-14T12:00:00.000Z'),
};

const lake = { id: 'lake1', name: 'Sales Intelligence' };

/** A loaded access view. `canTransferOwnership` defaults off - the server decides it, not the client. */
const loaded = (view: LakeAccessView, canTransferOwnership = false) => ({
  data: { view, canTransferOwnership },
  isLoading: false,
  isError: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  viewState = loaded(fullView);
  candidatesState = { data: { scope: 'organization', candidates: [], organizationName: 'Acme' }, isLoading: false };
});

describe('DataLakeAccessModal', () => {
  it('is closed when no lake is passed', () => {
    render(<DataLakeAccessModal lake={null} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('datalake-access-modal')).not.toBeInTheDocument();
  });

  it('renders grants, channels and history with the expired grant flagged', () => {
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByTestId('datalake-access-grants-table')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-access-grant-status-expired')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-access-channel-tag')).toHaveTextContent('vip');
    expect(screen.getByTestId('datalake-access-channel-organization')).toHaveTextContent(
      'Acme (3 members with access)'
    );
    expect(screen.getByTestId('datalake-access-history-table')).toBeInTheDocument();
  });

  it('qualifies access history as a lower bound whether or not it has rows', () => {
    const { rerender } = render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    // Present alongside real rows: a populated table must not read as the complete record either.
    expect(screen.getByTestId('datalake-access-history-caveat')).toHaveTextContent(/lower bound/i);

    viewState = loaded({ ...fullView, history: [], historyTruncated: false });
    rerender(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />);
    expect(screen.getByTestId('datalake-access-history-caveat')).toHaveTextContent(
      /not proof that no one has read this lake/i
    );
  });

  it('warns when the history was truncated, saying the CSV carries the same window (not the full trail)', () => {
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    const alert = screen.getByTestId('datalake-access-history-truncated');
    expect(alert).toBeInTheDocument();
    // Must NOT tell the reader the CSV is the complete record - it is the same truncated window.
    expect(alert).toHaveTextContent(/same window/i);
    expect(alert).not.toHaveTextContent(/complete retained window/i);
  });

  it('reports candidate-cap pressure with both counts, qualified as window-scoped', () => {
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    const line = screen.getByTestId('datalake-access-cap-pressure');
    // Both numbers, never the at-cap count alone: 4 on its own reads as a rate out of every read.
    expect(line).toHaveTextContent(/4 of 9 reported read/i);
    expect(line).toHaveTextContent(/in this window/i);
    // Attribution wording: the cap is a property of the turn's whole candidate listing.
    expect(line).toHaveTextContent(/not reads this lake caused/i);
  });

  it('says not reported, rather than cap-free, when no read measured the cap', () => {
    viewState = loaded({ ...fullView, candidateCapPressure: { turnsWithSignal: 0, turnsAtCap: 0 } });
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByTestId('datalake-access-cap-pressure')).toHaveTextContent(/not reported for this window/i);
  });

  it('degrades to not-reported when the view carries no pressure object at all', () => {
    // A cached response from before the field, or an older server: rendering blank would read as
    // "measured, nothing to report".
    const { candidateCapPressure: _omitted, ...withoutPressure } = fullView;
    viewState = loaded(withoutPressure as LakeAccessView);
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByTestId('datalake-access-cap-pressure')).toHaveTextContent(/not reported for this window/i);
  });

  it('drops the window qualification when the history was not truncated', () => {
    viewState = loaded({ ...fullView, historyTruncated: false, windowStartsAt: undefined });
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByTestId('datalake-access-cap-pressure')).not.toHaveTextContent(/in this window/i);
  });

  it('flags that the channels compose conjunctively when a prerequisite narrows access', () => {
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    // fullView has an org channel AND a tag channel - effective access is their intersection.
    expect(screen.getByTestId('datalake-access-channels-compose-note')).toBeInTheDocument();
  });

  it('omits the composition note when a single channel is a standalone path', () => {
    viewState = loaded({ ...fullView, channels: [{ kind: 'public' }] });
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('datalake-access-channels-compose-note')).not.toBeInTheDocument();
  });

  it('exports the CSV via the download helper', async () => {
    downloadCsv.mockResolvedValue(undefined);
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-export-btn'));
    expect(downloadCsv).toHaveBeenCalledWith('lake1');
  });

  it('toasts when the export fails', async () => {
    downloadCsv.mockRejectedValue(new Error('boom'));
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-export-btn'));
    expect(toastError).toHaveBeenCalled();
  });

  it('shows the manager-only message on a 403', () => {
    viewState = { isLoading: false, isError: true, error: { response: { status: 403 } } };
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByTestId('datalake-access-error')).toHaveTextContent(/manage this data lake/i);
  });

  it('renders empty states when there are no grants, channels, or reads', () => {
    viewState = loaded({ ...fullView, grants: [], channels: [], history: [], historyTruncated: false });
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByTestId('datalake-access-grants-empty')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-access-channels-empty')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-access-history-empty')).toBeInTheDocument();
  });

  describe('transfer ownership', () => {
    const withCandidates = () => {
      viewState = loaded(fullView, true);
      candidatesState = {
        isLoading: false,
        data: {
          scope: 'organization',
          organizationName: 'Acme',
          candidates: [{ userId: 'u9', name: 'Carol', email: 'carol@example.com' }],
        },
      };
    };

    it('hides the control unless the SERVER says this viewer may transfer', () => {
      // A curator can open this modal but must not be offered a transfer: the manage gate that opens
      // the view is wider than the transfer rule, and only the server resolves the narrower one.
      render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
      expect(screen.queryByTestId('datalake-access-transfer-btn')).not.toBeInTheDocument();
    });

    it('transfers to the chosen member', async () => {
      withCandidates();
      transferMutate.mockResolvedValue({ newOwnerUserId: 'u9', demotedUserIds: ['u1'] });
      render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });

      await userEvent.click(screen.getByTestId('datalake-access-transfer-btn'));
      await userEvent.click(screen.getByTestId('datalake-transfer-owner-select'));
      await userEvent.click(screen.getByTestId('datalake-transfer-option-u9'));
      await userEvent.click(screen.getByTestId('datalake-transfer-confirm-btn'));

      expect(transferMutate).toHaveBeenCalledWith({ id: 'lake1', newOwnerUserId: 'u9' });
    });

    it('cannot confirm before a new owner is chosen', async () => {
      withCandidates();
      render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
      await userEvent.click(screen.getByTestId('datalake-access-transfer-btn'));
      expect(screen.getByTestId('datalake-transfer-confirm-btn')).toBeDisabled();
    });

    it('says the outgoing owner stays on as a curator, so the demotion is not a surprise', async () => {
      withCandidates();
      render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
      await userEvent.click(screen.getByTestId('datalake-access-transfer-btn'));
      expect(screen.getByTestId('datalake-transfer-modal')).toHaveTextContent(/curator/i);
    });

    it('explains the path for a personal lake instead of showing an empty picker', async () => {
      viewState = loaded(fullView, true);
      candidatesState = { data: { scope: 'personal', candidates: [] }, isLoading: false };
      render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
      await userEvent.click(screen.getByTestId('datalake-access-transfer-btn'));
      // An empty list has two very different causes; a personal lake must not read as "nobody here".
      expect(screen.getByTestId('datalake-transfer-personal')).toHaveTextContent(/organization/i);
      expect(screen.queryByTestId('datalake-transfer-owner-select')).not.toBeInTheDocument();
    });

    it('names the organization when it has nobody else eligible', async () => {
      viewState = loaded(fullView, true);
      render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
      await userEvent.click(screen.getByTestId('datalake-access-transfer-btn'));
      expect(screen.getByTestId('datalake-transfer-no-candidates')).toHaveTextContent(/Acme/);
    });

    it('says the member list could not be loaded rather than claiming the org has nobody', async () => {
      // The failure mode this guards: "no other member can receive this lake" is a factual claim
      // about the organization, and a request that never arrived cannot support it.
      viewState = loaded(fullView, true);
      candidatesState = { data: undefined, isLoading: false, isError: true };
      render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
      await userEvent.click(screen.getByTestId('datalake-access-transfer-btn'));

      expect(screen.getByTestId('datalake-transfer-error')).toHaveTextContent(/try again/i);
      expect(screen.queryByTestId('datalake-transfer-no-candidates')).not.toBeInTheDocument();
      expect(screen.queryByTestId('datalake-transfer-personal')).not.toBeInTheDocument();
      expect(screen.getByTestId('datalake-transfer-confirm-btn')).toBeDisabled();
    });

    it("warns that ownership overrides the lake's content gate, naming it", async () => {
      withCandidates();
      candidatesState.data = { ...candidatesState.data!, gate: { requiredUserTag: 'phi' } };
      render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
      await userEvent.click(screen.getByTestId('datalake-access-transfer-btn'));

      const warning = screen.getByTestId('datalake-transfer-gate-warning');
      expect(warning).toHaveTextContent(/phi/);
      expect(warning).toHaveTextContent(/whether or not they satisfy it/i);
      // The gate must not remove the option - it is disclosed, not enforced, on this path.
      expect(screen.getByTestId('datalake-transfer-owner-select')).toBeInTheDocument();
    });

    it('shows no gate warning for an ungated lake', async () => {
      withCandidates();
      render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
      await userEvent.click(screen.getByTestId('datalake-access-transfer-btn'));
      expect(screen.queryByTestId('datalake-transfer-gate-warning')).not.toBeInTheDocument();
    });

    it('keeps the dialog open when the transfer is refused, so another member can be picked', async () => {
      withCandidates();
      transferMutate.mockRejectedValue(new Error('nope'));
      const onClose = vi.fn();
      render(<DataLakeAccessModal lake={lake} onClose={onClose} />, { wrapper: Wrapper });

      await userEvent.click(screen.getByTestId('datalake-access-transfer-btn'));
      await userEvent.click(screen.getByTestId('datalake-transfer-owner-select'));
      await userEvent.click(screen.getByTestId('datalake-transfer-option-u9'));
      await userEvent.click(screen.getByTestId('datalake-transfer-confirm-btn'));

      expect(transferMutate).toHaveBeenCalled();
      expect(screen.getByTestId('datalake-transfer-modal')).toBeInTheDocument();
      // The rejection is the mutation's to report (its onError toasts the server's refusal text);
      // this dialog's only job is not to close and not to throw.
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});

import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { LakeAccessView, LakeOwnershipCandidateList } from '@bike4mind/common';
import { DataLakeAccessModal } from './DataLakeAccessModal';

const downloadCsv = vi.fn();
let viewState: {
  data?: { view: LakeAccessView; canTransferOwnership: boolean; readerGrantsEnforced: boolean };
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
};
let candidatesState: { data?: LakeOwnershipCandidateList; isLoading: boolean; isError?: boolean };
const transferMutate = vi.fn();
const grantMutate = vi.fn();
/** `mutateAsync`, because the confirm dialog awaits the DELETE to decide whether to close. */
const revokeMutate = vi.fn();
let revokePending = false;
/** The in-flight DELETE's own input, which is what scopes the pending state to one row. */
let revokeVariables: { principalType: string; principalId: string } | undefined;

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useLakeAccessView: () => viewState,
  useLakeOwnershipCandidates: () => candidatesState,
  useTransferLakeOwnership: () => ({ mutateAsync: transferMutate, isPending: false }),
  useGrantLakeAccess: () => ({ mutateAsync: grantMutate, isPending: false }),
  useRevokeLakeAccess: () => ({ mutateAsync: revokeMutate, isPending: revokePending, variables: revokeVariables }),
  downloadLakeAccessCsv: (...args: unknown[]) => downloadCsv(...args),
}));

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

/** Open the confirmation for one grant row, which is now the only path to a DELETE. */
const openRevokeConfirm = async (principalTestId: string) => {
  await userEvent.click(screen.getByTestId(`datalake-access-revoke-${principalTestId}`));
  return screen.getByTestId('datalake-revoke-modal');
};

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

/** A loaded access view. `canTransferOwnership` defaults off - the server decides it, not the client.
 *  `readerGrantsEnforced` defaults ON here so the disclosure note is opt-in per test rather than
 *  present in every unrelated assertion. */
const loaded = (view: LakeAccessView, canTransferOwnership = false, readerGrantsEnforced = true) => ({
  data: { view, canTransferOwnership, readerGrantsEnforced },
  isLoading: false,
  isError: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  revokePending = false;
  revokeVariables = undefined;
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
    // Attribution wording: the cap is a property of the turn's whole candidate listing, so the
    // contrast is with caps this lake caused - never with reads, which it plainly did cause.
    expect(line).toHaveTextContent(/not caps this lake caused/i);
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

describe('DataLakeAccessModal grant writes', () => {
  it('offers Revoke on a curator row and never on an ownership row', async () => {
    // The server refuses to revoke an owner grant (it would silently un-transfer the lake), so the
    // UI must not offer a control whose action the door rejects.
    viewState = loaded({
      ...fullView,
      grants: [
        { ...fullView.grants[0]!, principalId: 'owner1', role: 'owner' },
        { ...fullView.grants[0]!, principalId: 'cur1', role: 'curator' },
      ],
    });
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.queryByTestId('datalake-access-revoke-user-owner1')).not.toBeInTheDocument();
    await openRevokeConfirm('user-cur1');
    // The control opens the confirmation; nothing reaches the door until it is accepted.
    expect(revokeMutate).not.toHaveBeenCalled();
  });

  it('sends the DELETE only once the revoke is confirmed, and nothing at all on cancel', async () => {
    viewState = loaded({ ...fullView, grants: [{ ...fullView.grants[0]!, principalId: 'cur1', role: 'curator' }] });
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });

    await openRevokeConfirm('user-cur1');
    await userEvent.click(screen.getByTestId('datalake-revoke-cancel-btn'));
    expect(revokeMutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('datalake-revoke-modal')).not.toBeInTheDocument();

    await openRevokeConfirm('user-cur1');
    await userEvent.click(screen.getByTestId('datalake-revoke-confirm-btn'));
    expect(revokeMutate).toHaveBeenCalledWith({ id: 'lake1', principalType: 'user', principalId: 'cur1' });
    // Closed on success, so the second click of a double-click has no confirm left to hit.
    expect(screen.queryByTestId('datalake-revoke-modal')).not.toBeInTheDocument();
  });

  it('keeps the confirmation open when the door refuses, so the toast can be acted on', async () => {
    revokeMutate.mockRejectedValueOnce(new Error('nope'));
    viewState = loaded({ ...fullView, grants: [{ ...fullView.grants[0]!, principalId: 'cur1', role: 'curator' }] });
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });

    await openRevokeConfirm('user-cur1');
    await userEvent.click(screen.getByTestId('datalake-revoke-confirm-btn'));
    expect(screen.getByTestId('datalake-revoke-modal')).toBeInTheDocument();
  });

  it('locks its own confirm while the DELETE is in flight, so one confirmation cannot send two', async () => {
    viewState = loaded({ ...fullView, grants: [{ ...fullView.grants[0]!, principalId: 'cur1', role: 'curator' }] });
    const { rerender } = render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await openRevokeConfirm('user-cur1');

    revokePending = true;
    revokeVariables = { principalType: 'user', principalId: 'cur1' };
    rerender(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />);
    expect(screen.getByTestId('datalake-revoke-confirm-btn')).toBeDisabled();
  });

  it('names what an organization grant and a curator grant take away, and flags an already-lapsed one', async () => {
    viewState = loaded({
      ...fullView,
      grants: [
        { ...fullView.grants[0]!, principalType: 'organization', principalId: 'orgA', principalName: 'Acme' },
        { ...fullView.grants[0]!, principalId: 'cur1', role: 'curator', status: 'active', expiresAt: null },
      ],
    });
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });

    // An org row is the one whose blast radius is invisible from the name on it.
    await openRevokeConfirm('organization-orgA');
    expect(screen.getByTestId('datalake-revoke-org-warning')).toHaveTextContent(/everyone in Acme/i);
    // The seeded row is expired, so the copy must not promise it is cutting off live access.
    expect(screen.getByTestId('datalake-revoke-expired-note')).toHaveTextContent(/already lapsed/i);
    expect(screen.queryByTestId('datalake-revoke-effect-note')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('datalake-revoke-cancel-btn'));

    await openRevokeConfirm('user-cur1');
    // Mirror of the grant form's disclosure: the role carried injection trust, so revoking says so.
    expect(screen.getByTestId('datalake-revoke-curator-warning')).toHaveTextContent(/system-prompt trust/i);
    expect(screen.getByTestId('datalake-revoke-effect-note')).toHaveTextContent(/ends immediately/i);
    expect(screen.queryByTestId('datalake-revoke-org-warning')).not.toBeInTheDocument();
  });

  it('grants a reader by email, closing the form on success', async () => {
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-grant-btn'));
    await userEvent.type(screen.getByTestId('datalake-grant-email-input'), 'new@example.com');
    await userEvent.click(screen.getByTestId('datalake-grant-confirm-btn'));

    expect(grantMutate).toHaveBeenCalledWith({
      id: 'lake1',
      principalType: 'user',
      principalEmail: 'new@example.com',
      role: 'reader',
    });
    expect(screen.queryByTestId('datalake-grant-modal')).not.toBeInTheDocument();
  });

  it('keeps the form open when the server refuses, so the input is not lost', async () => {
    // The mutation's own onError surfaces the refusal text; the form's job is only to stay put.
    grantMutate.mockRejectedValueOnce(new Error('nope'));
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-grant-btn'));
    await userEvent.type(screen.getByTestId('datalake-grant-email-input'), 'new@example.com');
    await userEvent.click(screen.getByTestId('datalake-grant-confirm-btn'));

    expect(screen.getByTestId('datalake-grant-modal')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-grant-email-input')).toHaveValue('new@example.com');
  });

  it('offers the organization only when the lake HAS an owning org', async () => {
    // Membership never crosses organizations, so the only grantable org is the lake's own - and a
    // personal lake has none at all.
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-grant-btn'));
    await userEvent.click(screen.getByTestId('datalake-grant-principal-select'));
    expect(screen.getByTestId('datalake-grant-principal-org')).toHaveTextContent('Acme');

    // A lake with no organization channel: the same form offers no organization option at all.
    cleanup();
    viewState = loaded({ ...fullView, channels: [{ kind: 'tag', value: 'vip' }] });
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-grant-btn'));
    await userEvent.click(screen.getByTestId('datalake-grant-principal-select'));
    expect(screen.queryByTestId('datalake-grant-principal-org')).not.toBeInTheDocument();
  });

  it('submits an org grant against the lake OWN org id, not the label', async () => {
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-grant-btn'));
    await userEvent.click(screen.getByTestId('datalake-grant-principal-select'));
    await userEvent.click(screen.getByTestId('datalake-grant-principal-org'));
    await userEvent.click(screen.getByTestId('datalake-grant-confirm-btn'));

    // The channel's `value`, which is what refuseGrantWrite compares against the lake's own org.
    expect(grantMutate).toHaveBeenCalledWith({
      id: 'lake1',
      principalType: 'organization',
      principalId: 'orgA',
      role: 'reader',
    });
  });

  it('offers curator for a person and never for an organization', async () => {
    // An org curator grant confers management on nobody (its admins already manage the lake), and
    // the server refuses it - so the form must not offer a role the door rejects.
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-grant-btn'));
    await userEvent.click(screen.getByTestId('datalake-grant-role-select'));
    expect(screen.getByRole('option', { name: /curator/i })).toBeInTheDocument();
    // Chosen rather than dismissed with Escape, which Joy's Modal takes as a close of the whole form.
    await userEvent.click(screen.getByRole('option', { name: /reader/i }));

    await userEvent.click(screen.getByTestId('datalake-grant-principal-select'));
    await userEvent.click(screen.getByTestId('datalake-grant-principal-org'));
    await userEvent.click(screen.getByTestId('datalake-grant-role-select'));
    expect(screen.queryByRole('option', { name: /curator/i })).not.toBeInTheDocument();
  });

  it('discloses that a curator is trusted with the lake system prompt, and only for curator', async () => {
    // A curator grant is injection trust as well as access (getAccessibleDataLakePrompts), and the
    // grantee is an arbitrary person the actor names - so the role picker has to say so.
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-grant-btn'));
    expect(screen.queryByTestId('datalake-grant-curator-help')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('datalake-grant-role-select'));
    await userEvent.click(screen.getByRole('option', { name: /curator/i }));
    expect(screen.getByTestId('datalake-grant-curator-help')).toHaveTextContent(/system prompt/i);
  });

  it('composes the chosen expiry date as the END of that day', async () => {
    // A date alone parses as midnight UTC, which the server refuses as already lapsed for a grant
    // dated today.
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-grant-btn'));
    await userEvent.type(screen.getByTestId('datalake-grant-email-input'), 'new@example.com');
    await userEvent.click(screen.getByTestId('datalake-grant-expiry-mode-select'));
    await userEvent.click(screen.getByTestId('datalake-grant-expiry-on'));
    fireEvent.change(screen.getByTestId('datalake-grant-expiry-input'), { target: { value: '2027-03-04' } });
    await userEvent.click(screen.getByTestId('datalake-grant-confirm-btn'));

    expect(grantMutate).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: '2027-03-04T23:59:59.999Z' }));
  });

  it('omits expiresAt by default, so a re-grant leaves an existing expiry alone', async () => {
    // The key must be ABSENT, not null: `grantLakeAccess` reads absent as "leave it" and null as
    // "clear it", so sending null here would silently make every routine re-role permanent.
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-grant-btn'));
    await userEvent.type(screen.getByTestId('datalake-grant-email-input'), 'new@example.com');
    await userEvent.click(screen.getByTestId('datalake-grant-confirm-btn'));

    expect(grantMutate).toHaveBeenCalledWith(expect.not.objectContaining({ expiresAt: expect.anything() }));
  });

  it('sends expiresAt: null for "Never expires", which is what CLEARS an existing expiry', async () => {
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-grant-btn'));
    await userEvent.type(screen.getByTestId('datalake-grant-email-input'), 'new@example.com');
    await userEvent.click(screen.getByTestId('datalake-grant-expiry-mode-select'));
    await userEvent.click(screen.getByTestId('datalake-grant-expiry-never'));
    await userEvent.click(screen.getByTestId('datalake-grant-confirm-btn'));

    expect(grantMutate).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: null }));
  });

  it('cannot submit a date mode with no date, which would silently act as "keep"', async () => {
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-grant-btn'));
    await userEvent.type(screen.getByTestId('datalake-grant-email-input'), 'new@example.com');
    await userEvent.click(screen.getByTestId('datalake-grant-expiry-mode-select'));
    await userEvent.click(screen.getByTestId('datalake-grant-expiry-on'));

    expect(screen.getByTestId('datalake-grant-confirm-btn')).toBeDisabled();
    expect(grantMutate).not.toHaveBeenCalled();
  });

  it("shows an org grant's current expiry, and seeds the picker from it", async () => {
    // Knowable only for an ORGANIZATION principal: it is addressed by the id the view already
    // carries. A user is addressed by email, and the view never exposes one.
    viewState = loaded({
      ...fullView,
      grants: [
        {
          principalType: 'organization',
          principalId: 'orgA',
          principalName: 'Acme',
          role: 'reader',
          grantedByUserId: 'u1',
          grantedAt: new Date('2026-08-01T00:00:00.000Z'),
          expiresAt: new Date('2027-03-04T23:59:59.999Z'),
          status: 'active',
        },
      ],
    });
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-grant-btn'));
    await userEvent.click(screen.getByTestId('datalake-grant-principal-select'));
    await userEvent.click(screen.getByTestId('datalake-grant-principal-org'));

    expect(screen.getByTestId('datalake-grant-expiry-help')).toHaveTextContent(/current expiry of/i);
    await userEvent.click(screen.getByTestId('datalake-grant-expiry-mode-select'));
    await userEvent.click(screen.getByTestId('datalake-grant-expiry-on'));
    expect(screen.getByTestId('datalake-grant-expiry-input')).toHaveValue('2027-03-04');
  });

  it('says what an empty expiry means when the form cannot know the current one', async () => {
    // The two meanings of "no date chosen" are the bug this note exists for: a new grant never
    // expires, a re-grant keeps whatever it has.
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('datalake-access-grant-btn'));

    expect(screen.getByTestId('datalake-grant-expiry-help')).toHaveTextContent(/A new grant never expires/i);
    expect(screen.getByTestId('datalake-grant-expiry-help')).toHaveTextContent(
      /leaves their current expiry untouched/i
    );
  });

  it('disables Revoke on the row being revoked, so a double click cannot send a second DELETE', () => {
    revokePending = true;
    revokeVariables = { principalType: 'user', principalId: 'cur1' };
    viewState = loaded({
      ...fullView,
      grants: [
        { ...fullView.grants[0]!, principalId: 'cur1', role: 'curator' },
        { ...fullView.grants[0]!, principalId: 'rdr1', role: 'reader' },
      ],
    });
    render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByTestId('datalake-access-revoke-user-cur1')).toBeDisabled();
    // The other rows stay live: one shared flag greyed out the whole table, and Joy's `loading`
    // forces `disabled`, so a slow request read as a frozen panel rather than one busy row.
    expect(screen.getByTestId('datalake-access-revoke-user-rdr1')).not.toBeDisabled();
  });

  it('discloses that reader grants are recorded but not yet in force, and drops the note once they are', () => {
    viewState = loaded(fullView, false, false);
    const { rerender } = render(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByTestId('datalake-access-readers-not-enforced')).toHaveTextContent(/not yet in force/i);

    viewState = loaded(fullView, false, true);
    rerender(<DataLakeAccessModal lake={lake} onClose={vi.fn()} />);
    expect(screen.queryByTestId('datalake-access-readers-not-enforced')).not.toBeInTheDocument();
  });
});

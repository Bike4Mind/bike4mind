import React, { useRef, useState } from 'react';
import { Box, Button, Link, Sheet, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { DETECTION_LINK_SPEND_DAYS, type SuspensionReasonCategory, type UserDetectionLinks } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useUserDetectionLinks } from '@client/app/hooks/data/adminUserTimeline';
import { updateUserToServer } from '@client/app/utils/userAPICalls';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';
import {
  ActionDialog,
  ADMIN_REASON_PRESETS,
  DataTable,
  RelativeTime,
  SectionCard,
  StatusChip,
  undoAdminReason,
  useUndoToast,
  type DataColumn,
} from '../../shared';
import { DETECTOR_LABELS } from '../../shadowDetectorLabels';
import { VERDICT_DISPLAY } from '../../ShadowDetectionsTab';
import { formatCredits } from './actions/creditAdjustment';
import { useOpenUserProfile } from './useOpenUserProfile';
import type { AdminUserUpdate } from './actions/useAdminUserUpdate';
import { SUSPENSION_CATEGORY_REQUIRED, SuspensionCategoryField } from './actions/SuspensionCategoryField';

type LinkedAccount = UserDetectionLinks['accounts'][number];

const accountLabel = (account: Pick<LinkedAccount, 'id' | 'name' | 'email'>) =>
  account.name || account.email || account.id;

const accountNoun = (count: number) => (count === 1 ? 'account' : 'accounts');

/** Runs the single-account admin suspend once per account, so each gets its own audit entry and detection grading. */
async function setSuspended(
  accounts: readonly LinkedAccount[],
  change: { isBanned: true; category: SuspensionReasonCategory } | { isBanned: false },
  reason: string,
  shouldStop: () => boolean = () => false
): Promise<{ done: LinkedAccount[]; failed: LinkedAccount[] }> {
  const done: LinkedAccount[] = [];
  const failed: LinkedAccount[] = [];
  // One at a time: the first request may ask for step-up, and the rest reuse it. A stop (the admin
  // canceled) leaves the accounts not yet sent untouched; a request already sent still lands.
  for (const account of accounts) {
    if (shouldStop()) break;
    try {
      // A suspend defers its linked-account alert; propagateOnce sends one for the whole action. A
      // reinstate here is only ever the Undo of this action, so it removes the suspend's detection grades.
      const update: AdminUserUpdate & { deferLinkPropagation?: boolean } = {
        isBanned: change.isBanned,
        statusChangeReason: reason,
        ...(change.isBanned
          ? { suspensionReasonCategory: change.category, deferLinkPropagation: true }
          : { undoSuspension: true }),
      };
      await updateUserToServer(account.id, update);
      done.push(account);
    } catch (error) {
      if (isStepUpCancelled(error)) throw error;
      failed.push(account);
    }
  }
  return { done, failed };
}

/**
 * One linked-account alert for every account this action suspended, naming only links outside it.
 * Best effort: the suspends have landed, and a failure here is logged server-side.
 */
async function propagateOnce(accounts: readonly LinkedAccount[]): Promise<void> {
  if (accounts.length === 0) return;
  try {
    await api.post('/api/admin/users/linked-suspend-propagation', { userIds: accounts.map(account => account.id) });
  } catch {
    toast.warning('The linked-account check for these suspensions did not run. Check linked accounts by hand.');
  }
}

const SuspendLinkedDialog: React.FC<{
  accounts: readonly LinkedAccount[];
  onClose: () => void;
  onDone: () => void;
}> = ({ accounts, onClose, onDone }) => {
  const showUndo = useUndoToast();
  const [failed, setFailed] = useState<LinkedAccount[]>([]);
  const [category, setCategory] = useState<SuspensionReasonCategory | null>(null);
  // Accounts suspended by an earlier attempt of this dialog: a retry skips them, and undo covers them.
  const [suspended, setSuspendedAccounts] = useState<LinkedAccount[]>([]);
  const propagated = useRef(false);
  const inFlight = useRef(false);
  const closed = useRef(false);
  const finish = (done: readonly LinkedAccount[]) => {
    if (propagated.current) return;
    propagated.current = true;
    void propagateOnce(done);
  };
  // Closing after a partial failure still propagates for the accounts that were suspended.
  const close = () => {
    closed.current = true;
    if (!inFlight.current) finish(suspended);
    onClose();
  };

  const showSuspendedUndo = (allDone: LinkedAccount[], reason: string, message: string) => {
    let undoPending: LinkedAccount[] = allDone;
    showUndo({
      message: `${message} Undo does not restore API keys or canceled subscriptions.`,
      onUndo: async () => {
        const result = await setSuspended(undoPending, { isBanned: false }, undoAdminReason(reason));
        undoPending = result.failed;
        onDone();
        if (result.failed.length > 0)
          throw new Error(
            `${result.failed.length} of ${allDone.length} accounts were not reinstated. Undo again to retry them.`
          );
      },
    });
  };

  const handleConfirm = async (reason: string) => {
    if (!category) return;
    const remaining = accounts.filter(account => !suspended.some(done => done.id === account.id));
    inFlight.current = true;
    let result;
    try {
      result = await setSuspended(remaining, { isBanned: true, category }, reason, () => closed.current);
    } finally {
      inFlight.current = false;
    }
    const allDone = [...suspended, ...result.done];
    if (closed.current) {
      // Canceled mid-run: the accounts already sent are suspended and audited, so the action still ends
      // with a refresh, its one alert and an Undo for them; the accounts not yet sent were left alone.
      finish(allDone);
      onDone();
      if (allDone.length > 0)
        showSuspendedUndo(
          allDone,
          reason,
          `Canceled: ${allDone.length} of ${accounts.length} linked accounts were suspended before you canceled.`
        );
      return;
    }
    setSuspendedAccounts(allDone);
    setFailed(result.failed);
    onDone();
    if (result.failed.length > 0) {
      toast.error(
        `${result.failed.length} of ${accounts.length} accounts were not suspended. Confirm again to retry them.`
      );
      // Keeps the dialog open on the failures; the ones that landed are already suspended and audited.
      throw new Error(`${result.failed.length} of ${accounts.length} accounts were not suspended`);
    }
    finish(allDone);
    onClose();
    showSuspendedUndo(allDone, reason, `${allDone.length} linked ${accountNoun(allDone.length)} suspended.`);
  };

  return (
    <ActionDialog
      open
      onClose={close}
      title={`Suspend ${accounts.length} linked ${accountNoun(accounts.length)}?`}
      description="Each account is suspended on its own, exactly as from its profile: it is signed out everywhere, its API keys are revoked, its live Stripe subscriptions are canceled with no refund, and each gets its own admin log entry. An abuse reason also grades the detections that name it. One linked-account alert covers the whole action and leaves these accounts out. Their data is kept."
      reasonPresets={ADMIN_REASON_PRESETS.suspension}
      confirmLabel={`Suspend ${accounts.length} ${accountNoun(accounts.length)}`}
      tone="danger"
      blockedReason={category ? null : SUSPENSION_CATEGORY_REQUIRED}
      onConfirm={handleConfirm}
      // handleConfirm checks `closed` between accounts, so Cancel mid-run stops the ones not yet sent.
      cancelStopsWrite
      data-testid="suspend-linked-dialog"
    >
      <SuspensionCategoryField value={category} onChange={setCategory} testIdPrefix="suspend-linked-dialog" />
      <Sheet
        variant="outlined"
        sx={{
          borderRadius: 'md',
          bgcolor: 'admin.surface',
          borderColor: 'admin.border',
          maxHeight: 240,
          overflow: 'auto',
        }}
        data-testid="suspend-linked-dialog-accounts"
      >
        {accounts.map(account => (
          <Stack
            key={account.id}
            direction="row"
            justifyContent="space-between"
            gap={1}
            sx={{ px: 1.5, py: 0.75, borderBottom: '1px solid', borderColor: 'admin.border' }}
          >
            <Typography level="body-sm" noWrap>
              {accountLabel(account)}
            </Typography>
            <Stack direction="row" gap={1} alignItems="center" flexShrink={0}>
              {failed.some(item => item.id === account.id) && <StatusChip tone="bad" label="Failed" />}
              {suspended.some(item => item.id === account.id) && <StatusChip tone="good" label="Suspended" />}
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted', fontVariantNumeric: 'tabular-nums' }}>
                {formatCredits(account.spent)} spent, {account.activeApiKeys}{' '}
                {account.activeApiKeys === 1 ? 'key' : 'keys'}
              </Typography>
            </Stack>
          </Stack>
        ))}
      </Sheet>
    </ActionDialog>
  );
};

const DetectionList: React.FC<{ detections: UserDetectionLinks['detections'] }> = ({ detections }) => (
  <Stack gap={0.75} sx={{ px: 2, py: 1.5 }} data-testid="detection-links-detections">
    {detections.map(detection => {
      const verdict = detection.verdict ? VERDICT_DISPLAY[detection.verdict] : null;
      return (
        <Stack key={detection.id} direction="row" gap={1} alignItems="center" flexWrap="wrap">
          <StatusChip tone="neutral" label={DETECTOR_LABELS[detection.detector]} />
          <Typography level="body-sm">{detection.summary}</Typography>
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
            <RelativeTime at={detection.detectedAt} />
          </Typography>
          {verdict ? (
            <StatusChip tone={verdict.tone} label={verdict.label} />
          ) : (
            <StatusChip tone="warn" label="Unreviewed" />
          )}
        </Stack>
      );
    })}
  </Stack>
);

/**
 * Accounts that cohort shadow detections name together with this user, with one action to suspend the
 * ones still active. Renders nothing for a user no cohort detection names.
 */
export const DetectionLinkedAccountsCard: React.FC<{ userId: string }> = ({ userId }) => {
  const links = useUserDetectionLinks(userId);
  const openProfile = useOpenUserProfile();
  const queryClient = useQueryClient();
  const [suspending, setSuspending] = useState(false);

  if (!links.isError && !links.data?.detections.length) return null;

  const accounts = links.data?.accounts ?? [];
  const suspendable = accounts.filter(account => !account.isBanned);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const columns: DataColumn<LinkedAccount>[] = [
    {
      id: 'account',
      label: 'Account',
      sortValue: account => accountLabel(account).toLowerCase(),
      render: account => (
        <Stack direction="row" gap={1} alignItems="center" minWidth={0}>
          <Link
            component="button"
            type="button"
            level="body-sm"
            onClick={() => void openProfile(account.id)}
            title={accountLabel(account)}
            sx={{
              display: 'block',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textAlign: 'left',
            }}
            data-testid="detection-links-account-link"
          >
            {accountLabel(account)}
          </Link>
          {account.blocked && (
            <Box sx={{ flexShrink: 0 }}>
              <StatusChip tone="bad" label={account.isBanned ? 'Suspended' : 'Blocked'} />
            </Box>
          )}
        </Stack>
      ),
    },
    {
      id: 'signedUp',
      label: 'Signed up',
      width: '8rem',
      sortValue: account => account.signedUpAt?.getTime() ?? 0,
      render: account => (account.signedUpAt ? <RelativeTime at={account.signedUpAt} /> : '-'),
    },
    {
      id: 'spent',
      label: `Spent (${DETECTION_LINK_SPEND_DAYS}d)`,
      numeric: true,
      width: '8.5rem',
      sortValue: account => account.spent,
      render: account => formatCredits(account.spent),
    },
    {
      id: 'balance',
      label: 'Balance',
      numeric: true,
      width: '7rem',
      sortValue: account => account.balance,
      render: account => formatCredits(account.balance),
    },
    {
      id: 'keys',
      label: 'API keys',
      numeric: true,
      width: '6rem',
      sortValue: account => account.activeApiKeys,
      render: account => account.activeApiKeys,
    },
  ];

  return (
    <SectionCard
      title="Linked by detections"
      body="custom"
      action={
        suspendable.length > 0 && (
          // Outlined danger opens the flow; the solid confirm lives in the dialog (DESIGN_GUIDE.md).
          <Button
            size="sm"
            variant="outlined"
            color="danger"
            onClick={() => setSuspending(true)}
            sx={{ minHeight: 30 }}
            data-testid="detection-links-suspend-all-btn"
          >
            Suspend all linked ({suspendable.length})
          </Button>
        )
      }
      data-testid="user-profile-detection-links"
    >
      {links.data && <DetectionList detections={links.data.detections} />}
      <Box sx={{ px: 1, pb: 1 }}>
        <DataTable
          rows={accounts}
          columns={columns}
          getRowId={account => account.id}
          label="Accounts linked by detections"
          loading={links.isLoading}
          error={links.isError ? 'Linked accounts could not be loaded.' : undefined}
          onRetry={() => void links.refetch()}
          empty="No other account is named by these detections."
          pagination={false}
          minWidth="46rem"
          testId="detection-links-table"
          rowTestId={account => `detection-links-row-${account.id}`}
        />
      </Box>
      {links.data?.truncated && (
        <Typography level="body-xs" sx={{ px: 2, pb: 1.5, color: 'admin.inkMuted' }}>
          More accounts are linked than shown. Open the detections page for the full groups.
        </Typography>
      )}
      {suspending && (
        <SuspendLinkedDialog accounts={suspendable} onClose={() => setSuspending(false)} onDone={refresh} />
      )}
    </SectionCard>
  );
};

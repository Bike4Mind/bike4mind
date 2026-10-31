import { useEffect, useMemo, useState } from 'react';
import { Checkbox, FormControl, FormLabel, Input, Skeleton, Stack, Typography } from '@mui/joy';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import {
  ADMIN_USERS_BULK_MAX,
  ADMIN_USERS_BULK_MAX_CREDIT_ADD,
  ADMIN_USERS_BULK_MAX_CREDIT_TOTAL,
  type AdminUsersBulkAction,
  type AdminUsersBulkActionType,
  type AdminUsersBulkEmailDomains,
  type AdminUsersBulkPreview,
  type AdminUsersBulkTarget,
} from '@client/app/utils/adminUsersBulk';
import { getErrorMessage } from '@client/app/utils/error';
import { ActionDialog } from '../../shared/ActionDialog';
import { ADMIN_REASON_PRESETS } from '../../shared/adminReason';
import { SegmentedControl } from '../../shared/SegmentedControl';
import { useUndoToast } from '../../shared/UndoToast';
import { useAdminUsersBulkExecute, useAdminUsersBulkPreview, useAdminUsersBulkUndo } from './useAdminUsersBulk';

type CreditMode = 'set' | 'add' | 'subtract';

// Domains named in an informational line before it falls back to "and N more". Never applied to the
// domains a batch would block: the admin confirms every one of those.
const DOMAINS_SHOWN = 5;

type BulkActionCopy = {
  /** Button and dialog title. */
  label: string;
  confirmLabel: (count: string) => string;
  description: string;
  /** Past tense for the result toast: "Suspended 12 users". */
  done: string;
  tone: 'neutral' | 'danger';
  reasonPresets: readonly string[];
};

/** Bar order; Contain stays last because it bundles the three most destructive writes. */
export const USERS_BULK_ACTIONS: readonly AdminUsersBulkActionType[] = [
  'suspend',
  'restrict',
  'adjustCredits',
  'revokeApiKeys',
  'addTag',
  'contain',
];

export const USERS_BULK_ACTION_COPY: Record<AdminUsersBulkActionType, BulkActionCopy> = {
  suspend: {
    label: 'Suspend',
    confirmLabel: count => `Suspend ${count}`,
    description: 'Blocks sign-in, ends live sessions and disables their API keys.',
    done: 'Suspended',
    tone: 'danger',
    reasonPresets: ADMIN_REASON_PRESETS.bulkUserAction,
  },
  restrict: {
    label: 'Restrict',
    confirmLabel: count => `Restrict ${count}`,
    description: 'Turns off AI features. They can still sign in and reach their data.',
    done: 'Restricted',
    tone: 'neutral',
    reasonPresets: ADMIN_REASON_PRESETS.bulkUserAction,
  },
  adjustCredits: {
    label: 'Adjust credits',
    confirmLabel: count => `Adjust credits for ${count}`,
    description: 'Every change is written to the credit ledger.',
    done: 'Adjusted credits for',
    tone: 'neutral',
    reasonPresets: ADMIN_REASON_PRESETS.creditAdjustment,
  },
  revokeApiKeys: {
    label: 'Revoke API keys',
    confirmLabel: count => `Revoke keys for ${count}`,
    description: 'Disables every active API key they own. Keys made later are not affected.',
    done: 'Revoked API keys for',
    tone: 'danger',
    reasonPresets: ADMIN_REASON_PRESETS.bulkUserAction,
  },
  addTag: {
    label: 'Add tag',
    confirmLabel: count => `Tag ${count}`,
    description: 'Adds the tag to users who do not have it yet.',
    done: 'Tagged',
    tone: 'neutral',
    reasonPresets: ADMIN_REASON_PRESETS.bulkUserAction,
  },
  contain: {
    label: 'Contain',
    confirmLabel: count => `Contain ${count}`,
    description: 'Suspends them, sets their credits to 0 and revokes their API keys, together for each user.',
    done: 'Contained',
    tone: 'danger',
    reasonPresets: ADMIN_REASON_PRESETS.bulkAbuseResponse,
  },
};

const PREVIEW_DEBOUNCE_MS = 300;

const plural = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'user' : 'users'}`;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** The action the inputs describe, or `null` while they are incomplete. */
function buildAction(
  type: AdminUsersBulkActionType,
  creditMode: CreditMode,
  amount: string,
  tag: string,
  blockEmailDomains: boolean
): AdminUsersBulkAction | null {
  if (type === 'adjustCredits') {
    const value = Number(amount);
    if (amount.trim() === '' || !Number.isInteger(value) || value < 0 || value > ADMIN_USERS_BULK_MAX_CREDIT_ADD)
      return null;
    return { type, mode: creditMode, amount: value };
  }
  if (type === 'addTag') {
    const trimmed = tag.trim();
    return trimmed ? { type, tag: trimmed } : null;
  }
  if (type === 'contain' && blockEmailDomains) return { type, blockEmailDomains: true };
  return { type };
}

function domainList(domains: readonly string[]): string {
  const shown = domains.slice(0, DOMAINS_SHOWN).join(', ');
  return domains.length > DOMAINS_SHOWN ? `${shown} and ${domains.length - DOMAINS_SHOWN} more` : shown;
}

function emailDomainLines({ toBlock, alreadyBlocked, notOwned }: AdminUsersBulkEmailDomains): string[] {
  return [
    toBlock.length > 0
      ? `New signups blocked from ${toBlock.length.toLocaleString()} email domain${toBlock.length === 1 ? '' : 's'}: ${toBlock.join(', ')}.`
      : 'No new email domains to block.',
    alreadyBlocked.length > 0 ? `Already blocked: ${domainList(alreadyBlocked)}.` : null,
    notOwned.length > 0 ? `Skipped as public mail domains: ${domainList(notOwned)}.` : null,
  ].filter((line): line is string => line !== null);
}

function DryRunSummary({ preview, type }: { preview: AdminUsersBulkPreview; type: AdminUsersBulkActionType }) {
  const excluded = preview.excluded.self + preview.excluded.admins;
  const lines = [
    `${plural(preview.eligible - preview.alreadyApplied)} will change${preview.alreadyApplied > 0 ? `; ${preview.alreadyApplied.toLocaleString()} already match and are skipped` : ''}.`,
    excluded > 0 ? `${plural(excluded)} excluded (you and other admins).` : null,
    (type === 'revokeApiKeys' || type === 'contain' || type === 'suspend') && preview.apiKeysToRevoke > 0
      ? `${preview.apiKeysToRevoke.toLocaleString()} active API keys disabled.`
      : null,
    preview.creditsDelta !== 0
      ? `${Math.abs(preview.creditsDelta).toLocaleString()} credits ${preview.creditsDelta > 0 ? 'removed' : 'added'} in total.`
      : null,
    ...(preview.emailDomains ? emailDomainLines(preview.emailDomains) : []),
  ].filter((line): line is string => line !== null);
  return (
    <Stack gap={0.5} data-testid="admin-users-bulk-dry-run">
      {lines.map(line => (
        <Typography key={line} level="body-sm" sx={{ color: 'admin.inkSecondary' }}>
          {line}
        </Typography>
      ))}
      {preview.sample.length > 0 && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          Including {preview.sample.map(user => user.email ?? user.name ?? user.id).join(', ')}
          {preview.eligible > preview.sample.length ? ' and others' : ''}.
        </Typography>
      )}
    </Stack>
  );
}

/**
 * One audited bulk write over the selected users. The dry run re-runs as the inputs change; the
 * confirmed `eligible` count travels to execute, which refuses with 409 if the cohort moved.
 */
export function UsersBulkActionDialog({
  type,
  target,
  onClose,
  onDone,
}: {
  type: AdminUsersBulkActionType;
  target: AdminUsersBulkTarget;
  onClose: () => void;
  onDone: () => void;
}) {
  const copy = USERS_BULK_ACTION_COPY[type];
  const [creditMode, setCreditMode] = useState<CreditMode>('set');
  const [amount, setAmount] = useState(type === 'adjustCredits' ? '0' : '');
  const [tag, setTag] = useState('');
  const [blockDomains, setBlockDomains] = useState(false);
  // One key per dialog: a double submit or a retried request replays instead of acting twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const showUndoToast = useUndoToast();

  const action = useMemo(
    () => buildAction(type, creditMode, amount, tag, blockDomains),
    [type, creditMode, amount, tag, blockDomains]
  );
  const debouncedAction = useDebounced(action, PREVIEW_DEBOUNCE_MS);
  const previewRequest = useMemo(
    () => (debouncedAction ? { target, action: debouncedAction } : null),
    [target, debouncedAction]
  );
  const preview = useAdminUsersBulkPreview(previewRequest);
  const execute = useAdminUsersBulkExecute();
  const undo = useAdminUsersBulkUndo();

  // Stale while the debounced inputs catch up, so a count is never confirmed for other inputs.
  const current = debouncedAction === action ? preview.data : undefined;
  const blockedReason = !action
    ? type === 'addTag'
      ? 'Enter a tag.'
      : `Enter a whole number from 0 to ${ADMIN_USERS_BULK_MAX_CREDIT_ADD.toLocaleString()}.`
    : preview.isError
      ? 'The dry run failed. Close and try again.'
      : !current
        ? 'Counting the users this changes\u2026'
        : current.overCap
          ? `This matches ${current.eligible.toLocaleString()} users. Narrow the filters to ${ADMIN_USERS_BULK_MAX.toLocaleString()} or fewer.`
          : current.creditsOverCap
            ? `This batch would add more than ${ADMIN_USERS_BULK_MAX_CREDIT_TOTAL.toLocaleString()} credits in total. Lower the amount or select fewer users.`
            : current.eligible === 0
              ? 'None of the selected users can be changed.'
              : null;

  const eligible = current?.eligible ?? 0;

  const onConfirm = async (reason: string) => {
    if (!action || !current) return;
    try {
      const result = await execute.mutateAsync({
        target,
        action,
        reason,
        idempotencyKey,
        expectedCount: eligible,
        cohortHash: current.cohortHash,
      });
      onDone();
      onClose();
      if (result.failed.length > 0)
        toast.warning(`${result.failed.length.toLocaleString()} users could not be changed.`);
      if (result.partial)
        toast.warning(
          `Stopped after ${plural(result.applied)}; ${plural(result.remaining)} not changed. Run it again for the rest.`
        );
      const changed = result.applied > 0 || result.blockedDomains.length > 0;
      if (!changed) {
        toast.info('No users were changed.');
        return;
      }
      if (result.subscriptionCancelFailures.length > 0)
        toast.warning(
          `Could not cancel the Stripe subscriptions of ${plural(result.subscriptionCancelFailures.length)}. Cancel them in Stripe.`
        );
      const message =
        `${copy.done} ${plural(result.applied)}` +
        (result.blockedDomains.length > 0 ? `; blocked signups from ${result.blockedDomains.join(', ')}` : '') +
        (result.canceledSubscriptions > 0
          ? `; canceled ${result.canceledSubscriptions.toLocaleString()} Stripe subscription(s)`
          : '');
      // The server sets undoExpiresAt to no later than now when it could not store an undo record.
      if (Date.parse(result.undoExpiresAt) <= Date.now()) {
        toast.success(message);
        toast.warning('Undo is not available for this batch.');
        return;
      }
      showUndoToast({
        message,
        onUndo: async () => {
          const restored = await undo.mutateAsync(result.batchId);
          if (restored.stillBlockedDomains.length > 0)
            toast.warning(
              `Could not unblock ${domainList(restored.stillBlockedDomains)}. Remove them from the blocked email domains setting.`
            );
          if (restored.partial)
            toast.warning(
              `${plural(restored.remaining)} not restored before the time limit. Check them on their profiles.`
            );
          if (restored.subscriptionsNotRestored.length > 0)
            toast.warning(
              `${restored.subscriptionsNotRestored.length.toLocaleString()} canceled Stripe subscription(s) stay canceled; the users must subscribe again.`
            );
          if (restored.failed.length > 0)
            toast.warning(`${restored.failed.length.toLocaleString()} users could not be restored.`);
          else toast.success(`Restored ${plural(restored.restored)}`);
        },
      });
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 409) {
        toast.error('The matching users changed. Check the new count and confirm again.');
        await preview.refetch();
        return;
      }
      toast.error(`${copy.label} failed: ${getErrorMessage(error)}`);
    }
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={`${copy.label} ${current ? plural(eligible) : 'users'}`}
      description={copy.description}
      reasonPresets={copy.reasonPresets}
      confirmLabel={copy.confirmLabel(current ? plural(eligible) : 'users')}
      onConfirm={onConfirm}
      tone={copy.tone}
      blockedReason={blockedReason}
      pending={execute.isPending}
      data-testid={`admin-users-bulk-${type}`}
    >
      <Stack gap={1.5}>
        {type === 'adjustCredits' && (
          <Stack direction="row" alignItems="flex-end" gap={1.5} flexWrap="wrap">
            <SegmentedControl
              aria-label="Credit change"
              data-testid="admin-users-bulk-credit-mode"
              value={creditMode}
              options={[
                { value: 'set', label: 'Set to' },
                { value: 'add', label: 'Add' },
                { value: 'subtract', label: 'Remove' },
              ]}
              onChange={setCreditMode}
            />
            <FormControl sx={{ flex: '1 1 8rem' }}>
              <FormLabel>Credits</FormLabel>
              <Input
                value={amount}
                onChange={event => setAmount(event.target.value)}
                slotProps={{ input: { inputMode: 'numeric', 'data-testid': 'admin-users-bulk-credit-amount' } }}
              />
            </FormControl>
          </Stack>
        )}
        {type === 'addTag' && (
          <FormControl>
            <FormLabel>Tag</FormLabel>
            <Input
              value={tag}
              onChange={event => setTag(event.target.value)}
              slotProps={{ input: { maxLength: 64, 'data-testid': 'admin-users-bulk-tag-input' } }}
            />
          </FormControl>
        )}
        {type === 'contain' && (
          <Checkbox
            checked={blockDomains}
            onChange={event => setBlockDomains(event.target.checked)}
            label="Also block their email domains for new signups"
            slotProps={{ input: { 'data-testid': 'admin-users-bulk-block-domains-checkbox' } }}
          />
        )}
        {current ? (
          <DryRunSummary preview={current} type={type} />
        ) : action && !preview.isError ? (
          <Skeleton variant="text" level="body-sm" sx={{ width: '60%' }} />
        ) : null}
        {(type === 'contain' || type === 'suspend') && (
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
            You can undo this for 30 seconds afterwards
            {blockDomains ? ', which also unblocks the domains it added' : ''}. Sessions that were ended stay ended, and
            live Stripe subscriptions are canceled with no refund and stay canceled.
          </Typography>
        )}
      </Stack>
    </ActionDialog>
  );
}

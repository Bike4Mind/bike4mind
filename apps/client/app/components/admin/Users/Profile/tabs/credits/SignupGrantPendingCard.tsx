import React, { useState } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import {
  ActionDialog,
  ADMIN_REASON_PRESETS,
  ErrorState,
  PendingCreditsChips,
  PendingCreditsFacts,
  pendingNoopCopy,
  SectionCard,
} from '../../../../shared';
import {
  useAdminSignupGrantAction,
  useAdminSignupGrantPending,
  type SignupGrantAction,
} from '@client/app/hooks/data/adminSignupGrant';
import { formatCredits } from '../../actions/creditAdjustment';
import type { AdminUserProfile } from '../../userProfileModel';

type ActionCopy = {
  label: string;
  title: string;
  description: string;
  confirm: string;
  presets: readonly string[];
  tone: 'neutral' | 'danger';
};

const ACTION_COPY: Readonly<Record<SignupGrantAction, ActionCopy>> = {
  releaseHeld: {
    label: 'Release held',
    title: 'Release the held grant now?',
    description: 'Pays the held signup tranche now, outside the daily pools.',
    confirm: 'Release held grant',
    presets: ADMIN_REASON_PRESETS.signupGrantRelease,
    tone: 'neutral',
  },
  releaseRemaining: {
    label: 'Release remaining',
    title: 'Release the rest of the grant now?',
    description: 'Pays everything still to come from the signup grant now, outside the daily pools.',
    confirm: 'Release remaining',
    presets: ADMIN_REASON_PRESETS.signupGrantRelease,
    tone: 'neutral',
  },
  block: {
    label: 'Block',
    title: 'Block grants and rewards?',
    description:
      'Stops every future signup grant and reward for this account and pauses its queued rewards. Credits already granted stay, and unblocking resumes the schedule.',
    confirm: 'Block grants and rewards',
    presets: ADMIN_REASON_PRESETS.signupGrantBlock,
    tone: 'danger',
  },
  unblock: {
    label: 'Unblock',
    title: 'Resume grants and rewards?',
    description: 'The schedule resumes and any paused rewards return to the queue at their original place.',
    confirm: 'Unblock',
    presets: ADMIN_REASON_PRESETS.signupGrantUnblock,
    tone: 'neutral',
  },
};

const ACTION_ORDER: readonly SignupGrantAction[] = ['releaseHeld', 'releaseRemaining', 'block', 'unblock'];

/** Pending signup credits and the four admin actions on them, read from the account's own admin endpoint. */
export const SignupGrantPendingCard: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const pending = useAdminSignupGrantPending(user.id);
  const run = useAdminSignupGrantAction(user.id);
  const [open, setOpen] = useState<SignupGrantAction | null>(null);

  const confirm = async (action: SignupGrantAction, reason: string) => {
    try {
      const result = await run.mutateAsync({ action, reason });
      if (result.outcome === 'applied') {
        toast.success(
          result.credits > 0 ? `${formatCredits(result.credits)} credits released` : `${ACTION_COPY[action].label} done`
        );
      } else {
        toast.info(pendingNoopCopy(result.reason));
      }
      setOpen(null);
    } catch {
      toast.error(`${ACTION_COPY[action].label} failed. Try again.`);
      throw new Error('signup grant action failed');
    }
  };

  const data = pending.data;
  // Release remaining is a full-admin action; a delegated admin never sees the button.
  const visible = data ? ACTION_ORDER.filter(action => data.actions[action].permitted) : [];
  const live = data ? visible.filter(action => data.actions[action].available) : [];
  // An action that does not apply says why, except where the state itself already says it.
  const SELF_EVIDENT = ['not_held', 'not_blocked', 'already_blocked'];
  const unavailableNotes = data
    ? visible.flatMap(action => {
        const { available, reason } = data.actions[action];
        if (available || !reason || SELF_EVIDENT.includes(reason)) return [];
        const text =
          action === 'block' && reason === 'no_grant'
            ? 'Cannot block: this account has no signup grant.'
            : pendingNoopCopy(reason);
        return [{ action, text: action === 'block' ? text : `${ACTION_COPY[action].label}: ${text}` }];
      })
    : [];

  const body = () => {
    if (pending.isLoading) {
      return (
        <Typography level="body-sm" sx={{ p: 2, color: 'admin.inkMuted' }} data-testid="user-pending-loading">
          Loading pending credits...
        </Typography>
      );
    }
    if (pending.isError || !data) {
      return <ErrorState message="Pending credits could not be loaded." onRetry={() => void pending.refetch()} />;
    }
    return null;
  };

  return (
    <SectionCard
      title="Pending credits"
      body={data ? 'facts' : 'custom'}
      data-testid="user-credits-pending"
      action={
        data && (
          <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1}>
            <PendingCreditsChips pending={data} />
            {live.map(action => (
              <Button
                key={action}
                size="sm"
                variant="outlined"
                color={ACTION_COPY[action].tone === 'danger' ? 'danger' : 'neutral'}
                onClick={() => setOpen(action)}
                data-testid={`user-pending-${action}-btn`}
              >
                {ACTION_COPY[action].label}
              </Button>
            ))}
          </Stack>
        )
      }
    >
      {data ? (
        <>
          <PendingCreditsFacts pending={data} />
          {unavailableNotes.map(({ action, text }) => (
            <Typography
              key={action}
              level="body-xs"
              sx={{ gridColumn: '1 / -1', color: 'admin.inkMuted' }}
              data-testid={`user-pending-${action}-note`}
            >
              {text}
            </Typography>
          ))}
        </>
      ) : (
        body()
      )}
      {open && (
        <ActionDialog
          open
          onClose={() => setOpen(null)}
          title={ACTION_COPY[open].title}
          description={ACTION_COPY[open].description}
          reasonPresets={ACTION_COPY[open].presets}
          confirmLabel={ACTION_COPY[open].confirm}
          tone={ACTION_COPY[open].tone}
          pending={run.isPending}
          onConfirm={reason => confirm(open, reason)}
          data-testid={`user-pending-${open}-dialog`}
        />
      )}
    </SectionCard>
  );
};

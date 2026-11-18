import React, { useState } from 'react';
import { Button, ListDivider, MenuItem, Stack, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import {
  MODERATION_SEVERE_CATEGORIES,
  MODERATION_SOURCE_LABELS,
  adminUserProfilePath,
  type IModerationHit,
  type UserModerationStatus,
} from '@bike4mind/common';
import {
  ActionDialog,
  ADMIN_REASON_PRESETS,
  AdminPageHeader,
  AdminPermissionAction,
  DataTable,
  EmptyState,
  StatusChip,
  formatUtc,
  relativeTime,
  type DataColumn,
} from './shared';
import { RowActionsMenu } from './shared/RowActionsMenu';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { useAdminUserUpdate } from './Users/Profile/actions/useAdminUserUpdate';
import { adminActionCountsQueryKey } from '@client/app/hooks/data/adminActionCounts';
import {
  TEXT_MODERATION_REVIEW_QUERY_KEY,
  useTextModerationReview,
  type TextModerationReviewRow,
} from '@client/app/hooks/data/textModerationReview';

/** How many of a user's retained hits the list shows, newest first. */
const HITS_SHOWN = 3;

const STATUS_LABELS: Record<UserModerationStatus, { label: string; tone: AdminStatusTone }> = {
  active: { label: 'Active', tone: 'good' },
  throttled: { label: 'Throttled', tone: 'warn' },
  suspend_pending: { label: 'Suspension pending', tone: 'warn' },
  suspended: { label: 'Suspended', tone: 'bad' },
};

type Decision = 'suspended' | 'active' | 'throttled';

const DECISIONS: Record<
  Decision,
  { menuLabel: string; title: string; confirmLabel: string; tone: 'danger' | 'neutral'; presets: readonly string[] }
> = {
  suspended: {
    menuLabel: 'Confirm suspension',
    title: 'Confirm suspension',
    confirmLabel: 'Suspend account',
    tone: 'danger',
    presets: ADMIN_REASON_PRESETS.suspension,
  },
  active: {
    menuLabel: 'Return to active',
    title: 'Return to active',
    confirmLabel: 'Return to active',
    tone: 'neutral',
    presets: ADMIN_REASON_PRESETS.reinstatement,
  },
  throttled: {
    menuLabel: 'Keep throttled',
    title: 'Keep throttled',
    confirmLabel: 'Keep throttled',
    tone: 'neutral',
    presets: ADMIN_REASON_PRESETS.limitedTier,
  },
};

const decisionDescription = (decision: Decision, who: string) => {
  switch (decision) {
    case 'suspended':
      return `${who} is signed out everywhere, blocked at sign-in, and their API keys are deactivated.`;
    case 'active':
      return `${who} returns to normal limits. Their hit history stays on the account.`;
    case 'throttled':
      return `${who} stays on the tighter rate limit for another 24 hours, then returns to normal limits.`;
  }
};

const isSevere = (hit: Pick<IModerationHit, 'categories'>) =>
  hit.categories.some(category => MODERATION_SEVERE_CATEGORIES.includes(category));

const displayName = (row: TextModerationReviewRow) => row.name || row.email || row.id;

const HitList: React.FC<{ hits: IModerationHit[]; now: number }> = ({ hits, now }) => {
  if (hits.length === 0) return <Typography sx={{ color: 'admin.inkMuted' }}>-</Typography>;
  return (
    <Stack spacing={0.5}>
      {hits.slice(0, HITS_SHOWN).map((hit, index) => {
        const at = new Date(hit.at);
        return (
          <Typography key={`${hit.at}-${index}`} level="body-sm" data-testid="text-moderation-hit">
            <Typography component="time" dateTime={at.toISOString()} title={formatUtc(at)}>
              {relativeTime(at, now)}
            </Typography>
            {' - '}
            <Typography sx={{ fontWeight: isSevere(hit) ? 'lg' : undefined }}>
              {hit.categories.length > 0 ? hit.categories.join(', ') : 'No categories'}
            </Typography>
            {' - '}
            {MODERATION_SOURCE_LABELS[hit.source] ?? hit.source}
          </Typography>
        );
      })}
    </Stack>
  );
};

const ReviewRowActions: React.FC<{ row: TextModerationReviewRow; onDecide: (decision: Decision) => void }> = ({
  row,
  onDecide,
}) => {
  const status = row.moderation.status;
  const item = (decision: Decision) => (
    <MenuItem onClick={() => onDecide(decision)} data-testid={`text-moderation-row-${decision}-${row.id}`}>
      {DECISIONS[decision].menuLabel}
    </MenuItem>
  );
  return (
    <AdminPermissionAction requirement="users:moderate">
      {missing => (
        <RowActionsMenu
          testId={`text-moderation-row-actions-${row.id}`}
          ariaLabel={`Actions for ${displayName(row)}`}
          disabled={missing}
        >
          {(status !== 'active' || row.hasUnreviewedSevereHit) && item('active')}
          {status !== 'suspended' && item('throttled')}
          {status !== 'suspended' && <ListDivider />}
          {status !== 'suspended' && item('suspended')}
        </RowActionsMenu>
      )}
    </AdminPermissionAction>
  );
};

/** Applies one decision through the audited admin user update, keyed to the row being decided. */
const DecisionDialog: React.FC<{
  row: TextModerationReviewRow;
  decision: Decision;
  onClose: () => void;
}> = ({ row, decision, onClose }) => {
  const update = useAdminUserUpdate(row.id);
  const queryClient = useQueryClient();
  const config = DECISIONS[decision];
  return (
    <ActionDialog
      open
      onClose={onClose}
      title={config.title}
      description={decisionDescription(decision, displayName(row))}
      reasonPresets={config.presets}
      confirmLabel={config.confirmLabel}
      tone={config.tone}
      onConfirm={async reason => {
        await update({ moderationStatus: decision, statusChangeReason: reason });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: TEXT_MODERATION_REVIEW_QUERY_KEY }),
          queryClient.invalidateQueries({ queryKey: adminActionCountsQueryKey }),
        ]);
        onClose();
      }}
      data-testid={`text-moderation-${decision}-dialog`}
    />
  );
};

/**
 * Users whose text prompts were flagged and who need a human decision: throttled or pending
 * suspension, or with a severe-category hit no admin has acted on since. Decisions go through
 * PUT /api/users/[id]/update so they are audited like any other status change.
 */
export const TextModerationReviewTab: React.FC = () => {
  const review = useTextModerationReview();
  const [now] = useState(() => Date.now());
  const [pending, setPending] = useState<{ row: TextModerationReviewRow; decision: Decision } | null>(null);
  const rows = review.data ?? [];

  const columns: DataColumn<TextModerationReviewRow>[] = [
    {
      id: 'user',
      label: 'User',
      width: '14rem',
      render: row => (
        <Stack>
          <Typography
            component="a"
            href={adminUserProfilePath(row.id)}
            target="_blank"
            rel="noopener noreferrer"
            level="body-sm"
            data-testid={`text-moderation-user-link-${row.id}`}
          >
            {row.name || row.email || row.id}
          </Typography>
          {row.name && row.email && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              {row.email}
            </Typography>
          )}
        </Stack>
      ),
      sortValue: row => displayName(row).toLowerCase(),
    },
    {
      id: 'status',
      label: 'Status',
      width: '11rem',
      render: row => {
        const { label, tone } = STATUS_LABELS[row.moderation.status] ?? STATUS_LABELS.active;
        return (
          <Stack spacing={0.5} alignItems="flex-start">
            <StatusChip tone={tone} label={label} />
            {row.hasUnreviewedSevereHit && <StatusChip tone="bad" label="Severe category" />}
          </Stack>
        );
      },
      sortValue: row => row.moderation.status,
    },
    {
      id: 'hits',
      label: 'Recent hits',
      wrap: true,
      render: row => <HitList hits={row.moderation.hits ?? []} now={now} />,
      sortValue: row => (row.moderation.lastHitAt ? new Date(row.moderation.lastHitAt).getTime() : 0),
    },
    {
      id: 'total',
      label: 'Total',
      numeric: true,
      width: '5rem',
      render: row => row.moderation.hitCount,
      sortValue: row => row.moderation.hitCount,
    },
    {
      id: 'appeal',
      label: 'Appeal',
      wrap: true,
      width: '16rem',
      render: row =>
        row.moderation.appealText ? (
          <Typography level="body-sm">{row.moderation.appealText}</Typography>
        ) : (
          <Typography sx={{ color: 'admin.inkMuted' }}>-</Typography>
        ),
    },
  ];

  return (
    <Stack
      spacing={ADMIN_REGION_GAP}
      sx={{ bgcolor: 'admin.canvas', color: 'admin.ink', borderRadius: 'md' }}
      data-testid="admin-text-moderation-review-tab"
    >
      <AdminPageHeader
        title="Text moderation review"
        count={review.data ? rows.length : undefined}
        description="Users throttled or pending suspension for flagged prompts, and users with a severe-category hit since their last review."
      />
      <DataTable
        rows={rows}
        columns={columns}
        label="Text moderation review"
        getRowId={row => row.id}
        testId="text-moderation-review-table"
        rowTestId={row => `text-moderation-row-${row.id}`}
        loading={review.isPending}
        error={review.error ? "Couldn't load the review list." : undefined}
        onRetry={() => void review.refetch()}
        rowActions={row => <ReviewRowActions row={row} onDecide={decision => setPending({ row, decision })} />}
        minWidth="64rem"
        empty={
          <EmptyState
            title="No users need review"
            description="Users appear here when repeat flags throttle them or flag them for suspension, or when a prompt hits a severe category."
            action={
              <Button
                variant="outlined"
                onClick={() => void review.refetch()}
                data-testid="text-moderation-review-refresh-btn"
              >
                Refresh list
              </Button>
            }
          />
        }
      />
      {pending && (
        <DecisionDialog
          key={`${pending.row.id}-${pending.decision}`}
          row={pending.row}
          decision={pending.decision}
          onClose={() => setPending(null)}
        />
      )}
    </Stack>
  );
};

export default TextModerationReviewTab;

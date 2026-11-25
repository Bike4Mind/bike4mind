import React, { useState } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { interventionReleaseResponseSchema, type InterventionTier } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';
import { ActionDialog, ADMIN_REASON_PRESETS, RelativeTime, SectionCard, StatusChip } from './shared';

export const INTERVENTION_TIER_LABELS: Record<InterventionTier, string> = {
  contain: 'Contain',
  limit: 'Limit spend',
  verify: 'Require verification',
  holdGrant: 'Hold signup grant',
  review: 'Request review',
};

type HoldStatus = 'active' | 'released' | 'expired';

export interface InterventionRow {
  decisionId: string;
  tier: InterventionTier;
  policyVersion: number | null;
  reason: string;
  expiresAt: Date | null;
  status: HoldStatus | 'other';
  outcome?: string;
}

const STATUS_CHIP: Record<InterventionRow['status'], { tone: 'bad' | 'good' | 'neutral'; label: string }> = {
  active: { tone: 'bad', label: 'Active' },
  released: { tone: 'good', label: 'Released' },
  expired: { tone: 'neutral', label: 'Expired' },
  other: { tone: 'neutral', label: 'Not applied' },
};

interface WireHold {
  decisionId: string;
  tier: InterventionTier;
  policyVersion: number;
  reason: string;
  expiresAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
}

interface WireDecision {
  id: string;
  tier: InterventionTier;
  policyVersion: number | null;
  reason: string;
  expiresAt: string | null;
  outcome: string;
}

export const holdStatus = (
  hold: Pick<WireHold, 'releasedAt' | 'releasedBy' | 'expiresAt'>,
  now: number
): HoldStatus => {
  if (hold.releasedAt) return hold.releasedBy === 'expiry' ? 'expired' : 'released';
  return new Date(hold.expiresAt).getTime() > now ? 'active' : 'expired';
};

const decisionStatus = (decision: WireDecision): InterventionRow['status'] => {
  // A failed graduated decision can have applied some holds before it failed, so it stays releasable.
  if (decision.outcome === 'intervened' || (decision.outcome === 'failed' && decision.tier !== 'contain')) {
    return 'active';
  }
  if (decision.outcome === 'released' || decision.outcome === 'expired') return decision.outcome;
  return 'other';
};

const InterventionList: React.FC<{
  rows: InterventionRow[];
  testIdPrefix: string;
  onRelease: (row: InterventionRow) => void;
}> = ({ rows, testIdPrefix, onRelease }) => (
  <Stack gap={1}>
    {rows.map(row => (
      <Stack
        key={row.decisionId}
        direction="row"
        gap={1}
        alignItems="center"
        flexWrap="wrap"
        data-testid={`${testIdPrefix}-row`}
      >
        <StatusChip tone="neutral" label={INTERVENTION_TIER_LABELS[row.tier]} />
        <StatusChip {...STATUS_CHIP[row.status]} />
        <Typography level="body-sm" sx={{ flex: 1, minWidth: 200 }}>
          {row.reason}
          {row.policyVersion !== null && ` (policy v${row.policyVersion})`}
        </Typography>
        {row.expiresAt && row.status === 'active' && (
          <RelativeTime prefix="Expires" at={row.expiresAt} future data-testid={`${testIdPrefix}-expires`} />
        )}
        {row.status === 'active' && row.tier !== 'contain' && (
          <Button
            size="sm"
            variant="outlined"
            onClick={() => onRelease(row)}
            data-testid={`${testIdPrefix}-release-btn`}
          >
            Release
          </Button>
        )}
      </Stack>
    ))}
  </Stack>
);

const ReleaseDialog: React.FC<{
  row: InterventionRow;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
  testId: string;
}> = ({ row, onClose, onConfirm, testId }) => (
  <ActionDialog
    open
    onClose={onClose}
    title={`Release this ${INTERVENTION_TIER_LABELS[row.tier]} hold?`}
    description="Lifts only this automated hold. A manual restriction, a pending review, a held signup grant or another automated hold on the account stays as it is."
    reasonPresets={ADMIN_REASON_PRESETS.limitedTierLift}
    confirmLabel="Release hold"
    onConfirm={onConfirm}
    data-testid={testId}
  />
);

const useRelease = (url: string, invalidate: readonly unknown[], onDone: () => void) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ decisionId, reason }: { decisionId: string; reason: string }) => {
      const response = await api.post<unknown>(url, { decisionId, reason });
      return interventionReleaseResponseSchema.parse(response.data);
    },
    onSuccess: async result => {
      const released = result.released.reduce((count, row) => count + row.userIds.length, 0);
      const skipped = result.released.reduce((count, row) => count + (row.skippedUserIds?.length ?? 0), 0);
      const accounts = (count: number) => `${count} account${count === 1 ? '' : 's'}`;
      if (skipped > 0) {
        const message = `${accounts(skipped)} could not be released`;
        if (released > 0) toast.warning(`Released holds for ${accounts(released)}; ${message}`);
        else toast.error(`No holds released: ${message}`);
      } else if (released === 0) {
        toast.info('No active holds were released');
      } else {
        toast.success('Hold released');
        onDone();
      }
      await queryClient.invalidateQueries({ queryKey: invalidate });
    },
    onError: error => {
      if (!isStepUpCancelled(error)) toast.error('Could not release the hold');
    },
  });
};

/** Automated graduated holds on one account, with Release (pages/api/admin/users/[userId]/interventions.ts). */
export const InterventionHoldsCard: React.FC<{ userId: string }> = ({ userId }) => {
  const url = `/api/admin/users/${encodeURIComponent(userId)}/interventions`;
  const queryKey = ['admin', 'users', userId, 'interventions'] as const;
  const [releasing, setReleasing] = useState<InterventionRow | null>(null);
  const [now] = useState(Date.now);
  const { data } = useQuery({
    queryKey,
    queryFn: async () => (await api.get<{ data: WireHold[] }>(url)).data.data,
  });
  const release = useRelease(url, queryKey, () => setReleasing(null));
  if (!data || data.length === 0) return null;

  const rows: InterventionRow[] = data.map(hold => ({
    decisionId: hold.decisionId,
    tier: hold.tier,
    policyVersion: hold.policyVersion,
    reason: hold.reason,
    expiresAt: new Date(hold.expiresAt),
    status: holdStatus(hold, now),
  }));
  return (
    <SectionCard title="Automated holds" body="custom" data-testid="user-intervention-holds">
      <InterventionList rows={rows} testIdPrefix="user-intervention-hold" onRelease={setReleasing} />
      {releasing && (
        <ReleaseDialog
          row={releasing}
          onClose={() => setReleasing(null)}
          onConfirm={reason => release.mutateAsync({ decisionId: releasing.decisionId, reason }).then(() => undefined)}
          testId="user-intervention-release-dialog"
        />
      )}
    </SectionCard>
  );
};

/** Automated decisions one detection produced, with Release for an applied graduated hold. */
export const InterventionDecisionsPanel: React.FC<{ detectionId: string }> = ({ detectionId }) => {
  const url = '/api/admin/shadow-detections/decisions';
  const queryKey = ['admin', 'shadow-detections', detectionId, 'decisions'] as const;
  const [releasing, setReleasing] = useState<InterventionRow | null>(null);
  const { data } = useQuery({
    queryKey,
    queryFn: async () => (await api.get<{ data: WireDecision[] }>(url, { params: { detectionId } })).data.data,
  });
  const release = useRelease(url, queryKey, () => setReleasing(null));
  if (!data || data.length === 0) return null;

  const rows: InterventionRow[] = data.map(decision => ({
    decisionId: decision.id,
    tier: decision.tier,
    policyVersion: decision.policyVersion,
    reason: decision.reason,
    expiresAt: decision.expiresAt ? new Date(decision.expiresAt) : null,
    status: decisionStatus(decision),
  }));
  return (
    <Stack gap={1} data-testid="detection-intervention-decisions">
      <Typography level="title-sm">Automated decisions</Typography>
      <InterventionList rows={rows} testIdPrefix="detection-intervention-decision" onRelease={setReleasing} />
      {releasing && (
        <ReleaseDialog
          row={releasing}
          onClose={() => setReleasing(null)}
          onConfirm={reason => release.mutateAsync({ decisionId: releasing.decisionId, reason }).then(() => undefined)}
          testId="detection-intervention-release-dialog"
        />
      )}
    </Stack>
  );
};

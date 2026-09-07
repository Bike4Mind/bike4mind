import { useState } from 'react';
import {
  Box,
  Button,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Modal,
  ModalDialog,
  Tooltip,
  Typography,
} from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { DuplicateBucket, SourceIdentityTier, WireDuplicateGroup } from '@bike4mind/common';
import { useGetLakeMembershipDuplicates, useRecordMembershipDecision } from '@client/app/hooks/data/dataLakes';

/**
 * The owner-facing half of the same-identity admission check (#2238): the lake holds two generations
 * of one document, and this is where someone decides what to do about it.
 *
 * Three answers, and they are the repair plan's own vocabulary (`REPAIR_DECISIONS`) rather than a
 * second set of words for the same thing - a ruling made here and one made from a repair plan differ
 * only in the `source` stamped on the row:
 *
 *  - Keep newest: the older copies leave the lake. Lake-scoped, so each file stays in its owner's
 *    Files list and in every other lake, and the server's removal record backs an Undo.
 *  - Keep both: recorded so the question is not asked again unless the pair changes. Deliberate
 *    retention of a superseded document is a real outcome (`policy-v2.md` beside `policy-v3.md`),
 *    and without a record the next repair plan proposes the same collapse forever.
 *  - Cancel: not an answer. Nothing is sent, and the pair is offered again next time.
 *
 * The groups come from the health endpoint's membership report, which is the same
 * `buildDuplicateGroups` the checkpoint grades a fresh upload through - so what is offered here
 * cannot disagree with what was detected at admission. The server re-reads the group before it
 * records anything, so a stale panel cannot pin a ruling to a pair that has since changed.
 */

/** What each bucket lets an owner conclude. `proven-identical` is the only safe-to-collapse one. */
const BUCKET_COPY: Record<DuplicateBucket, { label: string; color: 'success' | 'warning' | 'neutral'; hint: string }> =
  {
    'proven-identical': {
      label: 'Identical',
      color: 'success',
      hint: 'Same extracted text at the same size. Keeping the newest loses nothing.',
    },
    differing: {
      label: 'Different content',
      color: 'warning',
      hint: 'These copies differ - most likely an older version beside a corrected one. Check before replacing.',
    },
    unverified: {
      label: 'Not compared',
      color: 'neutral',
      hint: 'At least one copy has not been processed yet, so their contents could not be compared.',
    },
  };

/** How the match was made. The weakest tier is the one that can be wrong, so it is always shown. */
const TIER_COPY: Record<SourceIdentityTier, string> = {
  driveFileId: 'Matched as the same Drive document.',
  relativePath: 'Matched by folder path and file name.',
  fileName: 'Matched by file name alone - confirm these are the same document before replacing.',
};

const formatDate = (value: Date | string | null) =>
  value
    ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : 'unknown';

function DuplicateGroupRow({ group, dataLakeId }: { group: WireDuplicateGroup; dataLakeId: string }) {
  const record = useRecordMembershipDecision();
  const bucket = BUCKET_COPY[group.bucket];

  return (
    <Box sx={{ py: 1.25 }} data-testid={`datalake-duplicate-group-${group.fileName}`}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography level="body-sm" textColor="text.primary" sx={{ fontWeight: 'lg' }} noWrap>
          {group.fileName}
        </Typography>
        <Tooltip title={bucket.hint} size="sm">
          <Chip size="sm" variant="soft" color={bucket.color} sx={{ fontSize: '11px' }}>
            {bucket.label}
          </Chip>
        </Tooltip>
        <Typography level="body-xs" textColor="text.secondary">
          {group.memberCount} copies
        </Typography>
      </Box>
      {/* textColor, not `sx.color`: Joy's body-xs default is a 50%-alpha tertiary that fails
          contrast on this surface. */}
      <Typography level="body-xs" textColor="text.secondary" sx={{ mt: 0.25 }}>
        {TIER_COPY[group.tier]}
      </Typography>
      <Box sx={{ mt: 0.5 }}>
        {group.members.map((member, index) => (
          <Typography key={member.fabFileId} level="body-xs" textColor="text.tertiary">
            {index === 0 ? 'Newest' : 'Older'}: added {formatDate(member.createdAt)}
            {/* Unicode escape, not the literal glyph: added lines in .tsx stay ASCII per CLAUDE.md. */}
            {typeof member.fileSize === 'number' && ` \u00B7 ${Math.round(member.fileSize / 1024)} KB`}
          </Typography>
        ))}
        {group.memberCount > group.members.length && (
          <Typography level="body-xs" textColor="text.tertiary">
            +{group.memberCount - group.members.length} more
          </Typography>
        )}
      </Box>
      <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
        <Button
          size="sm"
          variant="solid"
          color="primary"
          loading={record.isPending}
          disabled={record.isPending}
          onClick={() => record.mutate({ dataLakeId, fileName: group.fileName, decision: 'keep-newest' })}
          data-testid="datalake-duplicate-keepnewest-btn"
        >
          Keep newest
        </Button>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          disabled={record.isPending}
          onClick={() => record.mutate({ dataLakeId, fileName: group.fileName, decision: 'keep-both' })}
          data-testid="datalake-duplicate-keepboth-btn"
        >
          Keep both
        </Button>
      </Box>
    </Box>
  );
}

export function DuplicateAdmissionDialog({
  open,
  onClose,
  dataLakeId,
  lakeName,
  groups,
  stalledCount = 0,
}: {
  open: boolean;
  onClose: () => void;
  dataLakeId: string;
  lakeName: string;
  groups: WireDuplicateGroup[];
  /** Groups whose recorded ruling was never carried out - see the note where it is rendered. */
  stalledCount?: number;
}) {
  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 560, width: '100%' }} data-testid="datalake-duplicate-dialog">
        <DialogTitle>Duplicate documents in &ldquo;{lakeName}&rdquo;</DialogTitle>
        <DialogContent sx={{ maxHeight: '60vh' }}>
          <Typography level="body-sm" textColor="text.secondary">
            These names are held by more than one copy of the same document. Keeping the newest removes the older copies
            from this lake only - each file stays in its owner&apos;s Files list, in any other lake it belongs to, and
            you can undo it from the toast. Keeping both records your choice so you are not asked again.
          </Typography>
          {/* Answers the question a manager would otherwise have no way to answer: "I already
              decided this one." A ruling is written before the removal it implies, so a removal that
              failed leaves the ruling on record and the group still duplicated - and this door keeps
              offering it, because re-answering is what retries the removal. */}
          {stalledCount > 0 && (
            <Typography level="body-sm" textColor="warning.plainColor" data-testid="datalake-duplicate-stalled">
              {stalledCount} earlier decision{stalledCount === 1 ? '' : 's'} did not finish removing its older copies.
              Answering again will retry it.
            </Typography>
          )}
          <Divider sx={{ my: 1 }} />
          {groups.length === 0 ? (
            <Typography level="body-sm" textColor="text.secondary">
              Nothing left to resolve.
            </Typography>
          ) : (
            groups.map(group => <DuplicateGroupRow key={group.fileName} group={group} dataLakeId={dataLakeId} />)
          )}
        </DialogContent>
        <DialogActions>
          {/* Cancel is not an answer: nothing is sent, and the pair is offered again next time. */}
          <Button variant="plain" color="neutral" onClick={onClose} data-testid="datalake-duplicate-cancel-btn">
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}

/**
 * The affordance that reaches the dialog: a chip in the lake manager's badge row, shown only when
 * there is something to resolve and only to a principal who can act on it.
 *
 * Reads the manage-gated duplicates door rather than the health report beside it, because only that
 * door is ruling-aware: a group the owner answered with "keep both" is still a duplicate in the
 * health report forever, so a chip driven by health would re-ask the one question that was already
 * settled. `canManage` gates the fetch to match the route, which refuses a mere reader.
 */
export default function DuplicateAdmissionsChip({
  lakeId,
  lakeName,
  canManage,
}: {
  lakeId: string;
  lakeName: string;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Gated by the hook's own `enabled` flag rather than by nulling the id, which would key a second,
  // empty cache entry that no invalidation reaches.
  const { data: duplicates } = useGetLakeMembershipDuplicates(lakeId, canManage);
  const groups = duplicates?.open ?? [];

  if (!canManage || groups.length === 0) return null;
  // `openGroupCount` rather than `groups.length`: the payload caps the list, and a manager told
  // "3 duplicates" on a lake holding 60 would stop looking after the third.
  const openCount = duplicates?.openGroupCount ?? groups.length;

  return (
    <>
      <Tooltip title="Two or more copies of the same document are in this lake. Review and resolve." size="sm">
        <Chip
          size="sm"
          variant="soft"
          color="warning"
          startDecorator={<ContentCopyIcon sx={{ fontSize: 12 }} />}
          onClick={() => setOpen(true)}
          sx={{ fontSize: '11px', cursor: 'pointer' }}
          data-testid={`datalake-duplicates-chip-${lakeId}`}
        >
          {/* "to resolve", not "duplicates": the health badge beside this counts every member that
              shares a name, ruling-blind and over a different population, so two figures reading as
              the same quantity would look like a contradiction. This one counts open QUESTIONS. */}
          {openCount} to resolve
        </Chip>
      </Tooltip>
      <DuplicateAdmissionDialog
        open={open}
        onClose={() => setOpen(false)}
        dataLakeId={lakeId}
        lakeName={lakeName}
        groups={groups}
        stalledCount={duplicates?.stalledGroupCount ?? 0}
      />
    </>
  );
}

import { useState } from 'react';
import {
  Box,
  Button,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  Modal,
  ModalDialog,
  Tooltip,
  Typography,
} from '@mui/joy';
import StorageIcon from '@mui/icons-material/Storage';
import AddIcon from '@mui/icons-material/Add';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import PeopleOutlineIcon from '@mui/icons-material/PeopleOutline';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import { TREE_SCROLL_SX } from '@client/app/components/datalake/treeChrome';
import {
  useArchiveDataLake,
  usePermanentDeleteDataLake,
  useUnderChunkedCount,
  useRechunkDataLake,
  useLakeConvergencePlan,
  useConvergeDataLake,
} from '@client/app/hooks/data/dataLakes';
import { toast } from 'sonner';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import useStartChatWithLake from '@client/app/hooks/useStartChatWithLake';
import DataLakeEmptyState from '@client/app/components/datalake/DataLakeEmptyState';
import LakeHealthBadge from '@client/app/components/datalake/LakeHealthBadge';
import LakeDriveStatusChip from '@client/app/components/datalake/LakeDriveStatusChip';
import { lakeVisibilityLabel } from '@client/app/components/datalake/lakeVisibility';
import type { IDataLakeBatchSummary } from '@bike4mind/common';
import type { ManagerLake } from './shared';

// Right pane: selected lake's details + management actions

export function LakeInfoPanel({
  lake,
  fileCount,
  armCounts,
  taxonomyBatch,
  onOpenSettings,
  onOpenAccess,
  onOpenFallbackSettings,
  onReviewTaxonomy,
  onArchived,
  onDeleted,
}: {
  lake: ManagerLake;
  fileCount: number | undefined;
  /** Membership split by arm - meta-tagged vs prefix-only. See lakeArmCounts. */
  armCounts: { metaCount: number; prefixOnlyCount: number } | undefined;
  /** This lake's attention-worthy taxonomy batch, if any (see taxonomyBatchByLakeId). */
  taxonomyBatch: IDataLakeBatchSummary | undefined;
  onOpenSettings: () => void;
  /** Opens the owner-facing access & membership view (#1672) - manager-only, like settings. */
  onOpenAccess: () => void;
  /** Opens the narrower settings editor for a fallback (built-in) lake - see canManageSettings. */
  onOpenFallbackSettings: () => void;
  /** Opens the review/apply panel for a batch whose taxonomy suggestions are ready or failed. */
  onReviewTaxonomy: (batchId: string) => void;
  /** Called after the active lake is archived, so the panel exits to root instead of the
   *  derived activeLake re-binding to a lake that just left the list (and a later restore
   *  teleporting back in). */
  onArchived: () => void;
  /** Same exit-to-root need as onArchived: a direct delete also removes the lake from the
   *  active list, skipping the archive step entirely (the lifecycle 'delete' action has no
   *  archived-status precondition). */
  onDeleted: () => void;
}) {
  const openWizardForLake = useDataLakeWizardStore(s => s.openWizardForLake);
  const archiveLake = useArchiveDataLake();
  const deleteLake = usePermanentDeleteDataLake();
  const startChatWithLake = useStartChatWithLake();
  const [startingChat, setStartingChat] = useState(false);
  const visibility = lakeVisibilityLabel(lake);
  // "Rebuild passages": gated on canRebuild, NOT canManage - a fallback (built-in) lake has no
  // document to manage but can still be rebuilt by an admin (see assertLakeRebuildAccess). Only
  // surfaced when the lake actually has legacy oversized-chunk files to repair (the count
  // self-polls down as a rebuild wave drains).
  // !!: useUnderChunkedCount's `enabled` param defaults to true, which fires on `undefined`
  // specifically - an absent canRebuild (e.g. a rolling-deploy skew window against an older
  // server) would otherwise ENABLE the query rather than disable it. Coerce so absent reads as
  // false, matching every other truthiness check on this flag.
  const { data: rebuildStatus } = useUnderChunkedCount(lake.id, !!lake.canRebuild);
  const underChunkedCount = rebuildStatus?.underChunkedCount ?? 0;
  const failedCount = rebuildStatus?.failedCount ?? 0;
  const rechunk = useRechunkDataLake(lake.id);

  // Convergence toward the lake's OWN declared chunk policy (#1681). Distinct from "Rebuild
  // passages", which repairs a fixed legacy defect (oversized whole-document blobs) against a
  // universal threshold: this repairs drift from a policy THIS lake declares, so it only exists for
  // a lake with an explicit one. Same `canRebuild` gate as the sibling action - the server enforces
  // it again (assertLakeRebuildAccess) and the plan read is safe for any reader.
  const { data: convergencePlan } = useLakeConvergencePlan(lake.id, !!lake.canRebuild);
  const converge = useConvergeDataLake(lake.id);
  // Confirm dialog state: the bulk-change guard's whole point is that the share is SEEN before it
  // is accepted, so `confirm: true` is only ever sent from this dialog.
  const [convergeConfirmOpen, setConvergeConfirmOpen] = useState(false);
  // waveSize, NOT convergeableCount: the latter counts whole-lake drift before the cross-lake check,
  // so a lake whose entire remaining drift belongs to a lake requiring a different target would show
  // an action count that repairs nothing on every click, forever. Verified live on a preview.
  const convergeWaveSize = convergencePlan?.waveSize ?? 0;
  const convergeBlockedCount = convergencePlan?.crossLakeConflictCount ?? 0;
  const canConverge = !!lake.canRebuild && convergencePlan?.refusal === null && convergeWaveSize > 0;
  // Nothing to repair from here, but the lake is NOT converged - surfaced as its own advisory so the
  // absence of a button is explained rather than read as "healthy".
  const showConvergeBlocked =
    !!lake.canRebuild && convergencePlan?.refusal === null && convergeWaveSize === 0 && convergeBlockedCount > 0;

  return (
    <Box
      data-testid="datalake-manager-lakeinfo"
      sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}
    >
      {/* pr clears the modal's absolutely-positioned ModalClose (top-right). */}
      <Box sx={{ px: 3, pr: 6, pt: 2.5, pb: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1 }}>
          <Typography level="h4" sx={{ flex: 1, minWidth: 0 }}>
            {lake.name}
          </Typography>
          {/* Start chat is available to ANY user who can reach the lake (not manage-gated): it
              opens a session scoped to this lake, applying the lake's preferred prompt server-side.
              Minimal placement for now - see useStartChatWithLake's note; polish is a design follow-up. */}
          <Button
            size="sm"
            variant="soft"
            color="primary"
            startDecorator={<ChatBubbleOutlineIcon sx={{ fontSize: 16 }} />}
            data-testid={`datalake-startchat-btn-${lake.id}`}
            loading={startingChat}
            onClick={async () => {
              setStartingChat(true);
              try {
                await startChatWithLake(lake.id);
              } catch {
                toast.error('Could not start a chat with this lake');
              } finally {
                // Reset in finally, not only on error: a success that does not unmount this panel
                // (e.g. navigation interrupted) would otherwise leave the spinner stuck forever.
                setStartingChat(false);
              }
            }}
            sx={{ flexShrink: 0, fontSize: '13px' }}
          >
            Start chat
          </Button>
          {/* Add files / Settings / Archive are owner-or-admin only (the backend enforces the
              same rule). The nav surfaces other users' read-only public lakes too. */}
          {lake.canManage && (
            <>
              <Button
                size="sm"
                variant="soft"
                color="primary"
                startDecorator={<AddIcon sx={{ fontSize: 16 }} />}
                data-testid={`datalake-addfiles-btn-${lake.id}`}
                onClick={() =>
                  openWizardForLake({
                    id: lake.id,
                    slug: lake.slug,
                    name: lake.name,
                    fileTagPrefix: lake.fileTagPrefix,
                    requiredUserTag: lake.requiredUserTag,
                    requiredEntitlement: lake.requiredEntitlement,
                  })
                }
                sx={{ flexShrink: 0, fontSize: '13px' }}
              >
                Add files
              </Button>
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                startDecorator={<SettingsOutlinedIcon sx={{ fontSize: 16 }} />}
                data-testid={`datalake-settings-btn-${lake.id}`}
                onClick={onOpenSettings}
                sx={{ flexShrink: 0, fontSize: '13px' }}
              >
                Settings
              </Button>
              <Tooltip title="See who can access this lake, and who has read it" size="sm">
                <Button
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  startDecorator={<PeopleOutlineIcon sx={{ fontSize: 16 }} />}
                  data-testid={`datalake-access-btn-${lake.id}`}
                  onClick={onOpenAccess}
                  sx={{ flexShrink: 0, fontSize: '13px' }}
                >
                  Access
                </Button>
              </Tooltip>
              <Tooltip title="Archive (restorable from the manager home)" size="sm">
                <Button
                  size="sm"
                  variant="outlined"
                  color="warning"
                  startDecorator={<ArchiveOutlinedIcon sx={{ fontSize: 16 }} />}
                  data-testid={`datalake-archive-btn-${lake.id}`}
                  loading={archiveLake.isPending}
                  onClick={() => archiveLake.mutate(lake.id, { onSuccess: onArchived })}
                  sx={{ flexShrink: 0, fontSize: '13px' }}
                >
                  Archive
                </Button>
              </Tooltip>
            </>
          )}
          {/* A fallback lake's narrower settings editor (currently grounding mode only), same shape
              as the Rebuild gate below: canManageSettings is a NARROWER flag than canManage, so a
              fallback lake (canManage always false) can still get here. `!lake.canManage` excludes
              a DB lake, which already has this affordance inside the canManage fragment above via
              the full DataLakeSettingsModal. */}
          {lake.canManageSettings && !lake.canManage && (
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<SettingsOutlinedIcon sx={{ fontSize: 16 }} />}
              data-testid={`datalake-fallback-settings-btn-${lake.id}`}
              onClick={onOpenFallbackSettings}
              sx={{ flexShrink: 0, fontSize: '13px' }}
            >
              Settings
            </Button>
          )}
          {/* Rebuild passages is gated on canRebuild, a NARROWER flag than canManage: a fallback
              (built-in) lake has no document (canManage is always false for it) but can still be
              rebuilt by an admin. Deliberately its own condition, not folded into the canManage
              fragment above - that fragment's other affordances (rename/delete/visibility/file
              removal) would still 400 on a fallback lake. */}
          {lake.canRebuild && underChunkedCount > 0 && (
            <Tooltip
              title="Re-chunk files stored as oversized passages into retrieval-sized ones. Runs in bounded waves; safe to repeat until zero."
              size="sm"
            >
              <Button
                size="sm"
                variant="outlined"
                color="primary"
                startDecorator={<AutoFixHighIcon sx={{ fontSize: 16 }} />}
                data-testid={`datalake-rebuild-passages-btn-${lake.id}`}
                loading={rechunk.isPending}
                onClick={() => rechunk.mutate(undefined)}
                sx={{ flexShrink: 0, fontSize: '13px' }}
              >
                Rebuild passages
              </Button>
            </Tooltip>
          )}
          {/* Converge to policy (#1681). Only shown for a lake with an EXPLICIT chunk policy and
              something measurably off it - an `inherited` lake is measured and reported by health
              but never repaired (epic decision 5), so there is nothing to offer. */}
          {canConverge && (
            <Tooltip
              title={
                `Re-chunk ${convergeWaveSize} file(s) to this lake's declared passage target of ` +
                `${convergencePlan?.policy.requiredTarget} tokens. They are unsearchable until re-indexing ` +
                'completes. Runs in bounded waves; safe to repeat.'
              }
              size="sm"
            >
              <Button
                size="sm"
                variant="outlined"
                color="primary"
                startDecorator={<AutoFixHighIcon sx={{ fontSize: 16 }} />}
                data-testid={`datalake-converge-policy-btn-${lake.id}`}
                loading={converge.isPending}
                onClick={() =>
                  convergencePlan?.requiresConfirmation ? setConvergeConfirmOpen(true) : converge.mutate({})
                }
                sx={{ flexShrink: 0, fontSize: '13px' }}
              >
                Converge to policy ({convergeWaveSize})
              </Button>
            </Tooltip>
          )}
          {showConvergeBlocked && (
            <Tooltip
              title={
                `${convergeBlockedCount} file(s) in this lake do not satisfy its passage target and cannot be ` +
                'repaired here: another data lake requires a different target for them, so re-chunking would make ' +
                'the two lakes take turns rewriting them. Align the two lakes, or remove the files from one.'
              }
              size="sm"
            >
              <Chip
                size="sm"
                variant="soft"
                color="warning"
                data-testid={`datalake-converge-blocked-chip-${lake.id}`}
                sx={{ flexShrink: 0 }}
              >
                {convergeBlockedCount} blocked by another lake
              </Chip>
            </Tooltip>
          )}
          {/* Bulk-change guard (#1681 constraint 4). A mass rewrite is the signature of a
              MISCONFIGURED policy, and every individual change inside one looks locally reasonable -
              the share is the only place the mistake is visible, so it is stated before the button
              that accepts it, and `confirm: true` is sent from nowhere else. */}
          <Modal open={convergeConfirmOpen} onClose={() => setConvergeConfirmOpen(false)}>
            <ModalDialog data-testid="datalake-converge-confirm" role="alertdialog">
              {/* The share and the file count describe DIFFERENT populations and must both say which:
                  `changeShare` is whole-lake drift (every candidate, pre-wave-bound and pre-conflict)
                  and is what the guard fired on, while `convergeWaveSize` is what this click actually
                  rewrites. Stating one as a headline over the other reads as "40% == 25 files" and has
                  the owner accept a number they were never shown. */}
              <DialogTitle>
                {Math.round((convergencePlan?.changeShare ?? 0) * 100)}% of this lake is off-policy - re-chunk now?
              </DialogTitle>
              <DialogContent>
                <Typography level="body-sm">
                  {convergencePlan?.convergeableCount ?? 0} of {convergencePlan?.membersConsidered ?? 0} files do not
                  match this lake{"'"}s passage target of {convergencePlan?.policy.requiredTarget} tokens. Rewriting
                  this much of a lake at once usually means the policy itself is wrong - check the target before
                  continuing.
                </Typography>
                <Typography level="body-sm" sx={{ mt: 1 }}>
                  This run repairs the first {convergeWaveSize}; re-run it to continue through the rest.
                </Typography>
                <Typography level="body-sm" sx={{ mt: 1 }}>
                  Each file stops being findable by search from the moment it is rewritten until its re-indexing
                  finishes. Its old passages are deleted first, so there is nothing to serve in the meantime.
                </Typography>
                {(convergencePlan?.crossLakeConflictCount ?? 0) > 0 && (
                  <Typography level="body-sm" sx={{ mt: 1 }}>
                    {convergencePlan?.crossLakeConflictCount} file(s) are excluded because another data lake requires a
                    different passage target for them; repairing those would make the two lakes take turns rewriting
                    them.
                  </Typography>
                )}
              </DialogContent>
              <DialogActions>
                <Button
                  variant="solid"
                  color="warning"
                  data-testid="datalake-converge-confirm-btn"
                  loading={converge.isPending}
                  onClick={() => converge.mutate({ confirm: true }, { onSuccess: () => setConvergeConfirmOpen(false) })}
                >
                  Re-chunk anyway
                </Button>
                <Button variant="plain" color="neutral" onClick={() => setConvergeConfirmOpen(false)}>
                  Cancel
                </Button>
              </DialogActions>
            </ModalDialog>
          </Modal>
        </Box>
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
          {/* Not-your-lake marker: the sidebar lists lakes the caller can REACH, not only ones
              they own (org lakes, others' public lakes, and - for an admin - every tenant's, even
              private). Flagged here, next to Add files / Settings / Archive, so someone else's
              lake can't be mistaken for your own and managed by accident. */}
          {lake.isOwn === false && (
            <Chip
              size="sm"
              variant="soft"
              color="warning"
              startDecorator={<PersonOutlineIcon sx={{ fontSize: 12 }} />}
              sx={{ fontSize: '11px' }}
              data-testid={`datalake-manager-owner-chip-${lake.id}`}
            >
              {lake.ownerDisplayName ? `Owner: ${lake.ownerDisplayName}` : 'Owned by another user'}
            </Chip>
          )}
          <Chip size="sm" variant="soft" color="neutral" sx={{ fontSize: '11px' }}>
            {lake.fileTagPrefix}
          </Chip>
          {lake.requiredUserTag && (
            <Chip size="sm" variant="soft" color="primary" sx={{ fontSize: '11px' }}>
              {lake.requiredUserTag}
            </Chip>
          )}
          <Chip size="sm" variant="outlined" color="neutral" sx={{ fontSize: '11px' }}>
            {visibility}
          </Chip>
          {typeof fileCount === 'number' && (
            <Tooltip
              title={
                armCounts
                  ? `${armCounts.metaCount} by lake tag, ${armCounts.prefixOnlyCount} by content prefix only - counted in this lake's own membership scope`
                  : "Counted in this lake's own membership scope"
              }
              size="sm"
            >
              <Chip size="sm" variant="outlined" color="neutral" sx={{ fontSize: '11px' }}>
                {fileCount} {fileCount === 1 ? 'file' : 'files'} (as creator)
              </Chip>
            </Tooltip>
          )}
          {armCounts && armCounts.prefixOnlyCount > 0 && (
            <Chip
              size="sm"
              variant="soft"
              color="warning"
              sx={{ fontSize: '11px' }}
              data-testid={`datalake-armcounts-chip-${lake.id}`}
            >
              {armCounts.metaCount} by lake tag, {armCounts.prefixOnlyCount} by content prefix
            </Chip>
          )}
          {/* Attached-source marker: this panel is where a user comes to inspect or delete a lake,
              and it previously gave no sign a Drive folder was feeding it (#1645). */}
          <LakeDriveStatusChip lakeId={lake.id} organizationId={lake.organizationId} />
          {/* Derived retrievability health (#1666): reachable-content share + affected-file drill-down.
              Advisory only. Fetched lazily for the lake in view; renders nothing for an empty lake. */}
          <LakeHealthBadge lakeId={lake.id} failedFileCount={failedCount} />
          {/* Retrievability health: files still stored as oversized (pre-passage-target) chunks.
              Gated on canRebuild (not canManage), matching the button above - the count self-polls
              down as the Rebuild passages wave drains. */}
          {lake.canRebuild && underChunkedCount > 0 && (
            <Tooltip
              title="These files are stored as oversized passages; use Rebuild passages to re-chunk them."
              size="sm"
            >
              <Chip
                size="sm"
                variant="soft"
                color="warning"
                startDecorator={<AutoFixHighIcon sx={{ fontSize: 12 }} />}
                sx={{ fontSize: '11px' }}
                data-testid={`datalake-manager-rebuild-chip-${lake.id}`}
              >
                {underChunkedCount} to rebuild
              </Chip>
            </Tooltip>
          )}
          {/* A rebuild badge reaching zero doesn't mean success if some files failed to process -
              those won't retry on their own, so surface them distinctly. Gated on canRebuild OR
              canManage (not canManage alone): failedCount now comes from the canRebuild-gated
              rebuild-status query, so a fallback-lake admin who can rebuild but not manage must
              still see it, or "0 failed" is invisible to the only actor who can act on it. */}
          {(lake.canRebuild || lake.canManage) && failedCount > 0 && (
            <Tooltip
              title="These files failed to process (e.g. a corrupt or unparseable file) and won't retry automatically. Includes files that failed at upload, not only rebuild attempts - Rebuild passages cannot clear them. Open the file and Re-process, or re-upload it."
              size="sm"
            >
              <Chip
                size="sm"
                variant="soft"
                color="danger"
                startDecorator={<ErrorOutlineIcon sx={{ fontSize: 12 }} />}
                sx={{ fontSize: '11px' }}
                data-testid={`datalake-manager-rebuild-failed-chip-${lake.id}`}
              >
                {failedCount} failed
              </Chip>
            </Tooltip>
          )}
          {/* Background AI-tag suggestion progress - an independent clock from ingest, so this
              can appear well after the lake's files are already fully uploaded/searchable. */}
          {(taxonomyBatch?.taxonomyStatus === 'queued' || taxonomyBatch?.taxonomyStatus === 'analyzing') && (
            <Tooltip title="Usually ready in under a minute" size="sm">
              <Chip
                size="sm"
                variant="soft"
                color="primary"
                startDecorator={<AutoAwesomeIcon sx={{ fontSize: 12 }} />}
                sx={{ fontSize: '11px' }}
                data-testid={`datalake-manager-taxonomy-progress-chip-${lake.id}`}
              >
                AI tagging&hellip;
              </Chip>
            </Tooltip>
          )}
          {taxonomyBatch?.taxonomyStatus === 'ready' && (
            <Chip
              size="sm"
              variant="solid"
              color="success"
              startDecorator={<AutoAwesomeIcon sx={{ fontSize: 12 }} />}
              sx={{ fontSize: '11px', cursor: 'pointer' }}
              data-testid={`datalake-manager-taxonomy-review-chip-${lake.id}`}
              onClick={() => onReviewTaxonomy(taxonomyBatch.id)}
            >
              Review AI tags
            </Chip>
          )}
          {taxonomyBatch?.taxonomyStatus === 'failed' && (
            <Chip
              size="sm"
              variant="soft"
              color="warning"
              startDecorator={<ErrorOutlineIcon sx={{ fontSize: 12 }} />}
              sx={{ fontSize: '11px', cursor: 'pointer' }}
              data-testid={`datalake-manager-taxonomy-failed-chip-${lake.id}`}
              onClick={() => onReviewTaxonomy(taxonomyBatch.id)}
            >
              AI tagging failed
            </Chip>
          )}
        </Box>
        {lake.canManage && (
          <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
            <Tooltip title="Delete (recoverable - restore from the Deleted section)" size="sm">
              <Button
                variant="outlined"
                color="danger"
                size="sm"
                startDecorator={<DeleteOutlineIcon sx={{ fontSize: 16 }} />}
                data-testid={`datalake-delete-active-btn-${lake.id}`}
                loading={deleteLake.isPending}
                onClick={() => deleteLake.mutate(lake.id, { onSuccess: onDeleted })}
                sx={{ flexShrink: 0, fontSize: '13px' }}
              >
                Delete
              </Button>
            </Tooltip>
          </Box>
        )}
      </Box>
      <Box sx={{ ...TREE_SCROLL_SX, px: 3, py: 2 }}>
        {lake.description ? (
          <Typography level="body-md" sx={{ whiteSpace: 'pre-wrap' }}>
            {lake.description}
          </Typography>
        ) : (
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            No description.
          </Typography>
        )}
        <Typography level="body-sm" sx={{ color: 'text.tertiary', mt: 2 }}>
          Browse the categories and files in the left sidebar - click a file to read it here.
        </Typography>
      </Box>
    </Box>
  );
}

// Right pane at root: pick-a-lake hint (the lifecycle sections live in the sidebar accordions)

export function ManagerOverview() {
  return (
    <DataLakeEmptyState
      icon={<StorageIcon sx={{ fontSize: 18, color: 'text.tertiary' }} />}
      title="Select a data lake"
      data-testid="datalake-manager-overview"
    >
      Pick a lake on the left to see its details
      <br /> and browse its files, or create a new one.
    </DataLakeEmptyState>
  );
}

import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  DialogActions,
  DialogContent,
  DialogTitle,
  Modal,
  ModalClose,
  ModalDialog,
  Option,
  Select,
  Sheet,
  Stack,
  Table,
  Typography,
} from '@mui/joy';
import type {
  DataLakeAccessRole,
  LakeAccessChannel,
  LakeAccessGrantView,
  LakeAccessHistoryEntry,
  LakeAccessView,
  LakeOwnershipCandidateList,
} from '@bike4mind/common';
import { describeLakeAccessChannel, lakeAccessChannelsComposeConjunctively } from '@bike4mind/common';
import type { ColorPaletteProp } from '@mui/joy';
import {
  useLakeAccessView,
  useLakeOwnershipCandidates,
  useTransferLakeOwnership,
  downloadLakeAccessCsv,
} from '@client/app/hooks/data/dataLakes';
import { toast } from 'sonner';

/** A lake this modal can show access for - just what the entry point already holds. */
export interface AccessViewLake {
  id: string;
  name: string;
}

const fmtDate = (d: Date | string | null | undefined): string =>
  d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

const fmtDateTime = (d: Date | string | null | undefined): string =>
  d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

// Keyed by the role enum so a new role fails the build here rather than silently rendering blank.
const ROLE_COLOR: Record<DataLakeAccessRole, ColorPaletteProp> = {
  owner: 'primary',
  curator: 'success',
  reader: 'neutral',
};

function GrantRow({ grant }: { grant: LakeAccessGrantView }) {
  return (
    <tr data-testid="datalake-access-grant-row">
      <td>
        <Typography level="body-sm">{grant.principalName ?? grant.principalId}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {grant.principalType}
        </Typography>
      </td>
      <td>
        <Chip size="sm" color={ROLE_COLOR[grant.role]} variant="soft">
          {grant.role}
        </Chip>
      </td>
      <td>
        <Chip
          size="sm"
          variant="soft"
          color={grant.status === 'active' ? 'success' : 'warning'}
          data-testid={`datalake-access-grant-status-${grant.status}`}
        >
          {grant.status}
        </Chip>
      </td>
      <td>
        <Typography level="body-sm">{grant.grantedByName ?? grant.grantedByUserId}</Typography>
      </td>
      <td>
        <Typography level="body-sm">{fmtDate(grant.grantedAt)}</Typography>
      </td>
      <td>
        <Typography level="body-sm">{grant.expiresAt ? fmtDate(grant.expiresAt) : 'Never'}</Typography>
      </td>
    </tr>
  );
}

function ChannelChip({ channel }: { channel: LakeAccessChannel }) {
  // Rendered text comes from the shared describer so this chip and the CSV export can never drift.
  return (
    <Chip size="md" variant="outlined" color="neutral" data-testid={`datalake-access-channel-${channel.kind}`}>
      {describeLakeAccessChannel(channel)}
    </Chip>
  );
}

function HistoryRow({ entry }: { entry: LakeAccessHistoryEntry }) {
  return (
    <tr data-testid="datalake-access-history-row">
      <td>
        <Typography level="body-sm">{entry.principalName ?? entry.principalId}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {entry.principalKind}
          {entry.onBehalfOfUserId ? ` (for ${entry.onBehalfOfName ?? entry.onBehalfOfUserId})` : ''}
        </Typography>
      </td>
      <td>
        <Typography level="body-sm">{entry.readCount}</Typography>
      </td>
      <td>
        <Typography level="body-sm">{fmtDateTime(entry.lastAccessedAt)}</Typography>
      </td>
      <td>
        <Typography level="body-xs" textColor="text.tertiary">
          {entry.surfaces.join(', ')}
        </Typography>
      </td>
    </tr>
  );
}

/**
 * What the lake's content gate demands, in prose, for the transfer confirmation. Returns null for an
 * ungated lake. Deliberately quotes the raw tag/entitlement key: it is what an owner sees on the
 * lake's own settings, so an invented friendly name would be a second vocabulary for one thing.
 */
function describeLakeGate(gate: LakeOwnershipCandidateList['gate']): string | null {
  if (!gate) return null;
  const parts: string[] = [];
  if (gate.requiredUserTag) parts.push(`the access tag "${gate.requiredUserTag}"`);
  if (gate.requiredEntitlement) parts.push(`the entitlement "${gate.requiredEntitlement}"`);
  return parts.length > 0 ? parts.join(' and ') : null;
}

/**
 * Hand this lake to another member of its organization.
 *
 * Confirm-gated because the actor demotes THEMSELVES: the outgoing owner stays on as a curator, so
 * they keep routine management, but the owner-only powers (transferring again, and the visibility
 * expose gate) move to the recipient. That is reversible only by the new owner, which is exactly why
 * it is worth one deliberate click.
 *
 * The options come from the server, resolved from the owning org's membership by the same rule the
 * transfer itself validates, so this can never offer a teammate the action would then reject. A
 * personal lake has no membership to enumerate, so it explains the path rather than showing an empty
 * picker (see `listLakeOwnershipCandidates`).
 */
function TransferOwnershipDialog({ lakeId, onClose }: { lakeId: string; onClose: () => void }) {
  const { data: candidateList, isLoading, isError } = useLakeOwnershipCandidates(lakeId);
  const transfer = useTransferLakeOwnership();
  const [newOwnerUserId, setNewOwnerUserId] = useState<string | null>(null);

  const candidates = candidateList?.candidates ?? [];
  const orgName = candidateList?.organizationName;
  const gateDescription = describeLakeGate(candidateList?.gate);

  const handleConfirm = async () => {
    if (!newOwnerUserId) return;
    try {
      await transfer.mutateAsync({ id: lakeId, newOwnerUserId });
      onClose();
    } catch {
      // The mutation's onError already surfaced the server's refusal; keep the dialog open so the
      // manager can pick someone else rather than losing their place.
    }
  };

  return (
    <Modal open onClose={onClose}>
      <ModalDialog data-testid="datalake-transfer-modal" sx={{ width: { xs: '95%', sm: '28rem' } }}>
        <ModalClose data-testid="datalake-transfer-close" />
        <DialogTitle>Transfer ownership</DialogTitle>
        <DialogContent>
          <Stack gap={2} sx={{ pt: 1 }}>
            {isLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }} data-testid="datalake-transfer-loading">
                <CircularProgress size="sm" />
              </Box>
            ) : isError ? (
              // A failed fetch must NOT fall through to the empty-candidates branch below: "no other
              // member can receive this lake" is a claim about the organization's membership, and a
              // request that never arrived cannot support it. The query is retry: false, so one
              // failure is the final answer until the dialog is reopened.
              <Alert color="danger" variant="soft" data-testid="datalake-transfer-error">
                Couldn&apos;t load the member list, so there is no one to choose from here. Close this and try again.
              </Alert>
            ) : candidateList?.scope === 'personal' ? (
              <Alert color="neutral" variant="soft" data-testid="datalake-transfer-personal">
                This lake is personal, so there is no team to transfer it within. Move it into an organization first
                (Settings -&gt; Visibility -&gt; Organization), then transfer it to a member.
              </Alert>
            ) : candidates.length === 0 ? (
              <Alert color="neutral" variant="soft" data-testid="datalake-transfer-no-candidates">
                {orgName
                  ? `No other member of ${orgName} can receive this lake yet. Add them to the organization first.`
                  : 'No other member can receive this lake yet.'}
              </Alert>
            ) : (
              <>
                <Typography level="body-sm">
                  The new owner takes over this lake. You stay on as a curator - you keep managing it, but only the
                  owner can transfer it again or change how it is shared.
                </Typography>
                {/* Ownership bypasses the lake's own content gate (the owner arm of the read decision
                    returns before the tag/entitlement arm runs), and the picker deliberately offers
                    every org member rather than only gate-holders. Saying so is what keeps handing
                    gated content to someone who does not qualify a deliberate choice - contrast
                    publishing a gated lake, which is refused outright. */}
                {gateDescription && (
                  <Alert color="warning" variant="soft" data-testid="datalake-transfer-gate-warning">
                    This lake is gated on {gateDescription}. Ownership overrides that gate: whoever you choose can read
                    everything in the lake, whether or not they satisfy it today.
                  </Alert>
                )}
                <Select
                  placeholder="Choose a new owner"
                  value={newOwnerUserId}
                  onChange={(_event, value) => setNewOwnerUserId(value)}
                  slotProps={{ button: { 'data-testid': 'datalake-transfer-owner-select' } }}
                >
                  {candidates.map(candidate => (
                    <Option
                      key={candidate.userId}
                      value={candidate.userId}
                      data-testid={`datalake-transfer-option-${candidate.userId}`}
                    >
                      {candidate.name ?? candidate.email ?? candidate.userId}
                      {candidate.name && candidate.email ? ` (${candidate.email})` : ''}
                    </Option>
                  ))}
                </Select>
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            color="primary"
            disabled={!newOwnerUserId}
            loading={transfer.isPending}
            onClick={handleConfirm}
            data-testid="datalake-transfer-confirm-btn"
          >
            Transfer
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose} data-testid="datalake-transfer-cancel-btn">
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}

function AccessViewBody({ view, canTransferOwnership }: { view: LakeAccessView; canTransferOwnership: boolean }) {
  const [transferring, setTransferring] = useState(false);
  return (
    <Stack gap={3} data-testid="datalake-access-body">
      {/* Who can see this: explicit grants */}
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 1 }}>
          <Typography level="title-sm">Members and grants</Typography>
          {/* Shown on the server's say-so, never re-derived here: transferring is NARROWER than the
              manage gate that opened this modal, so a curator sees the table without this control. */}
          {canTransferOwnership && (
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              onClick={() => setTransferring(true)}
              data-testid="datalake-access-transfer-btn"
            >
              Transfer ownership
            </Button>
          )}
        </Box>
        {transferring && <TransferOwnershipDialog lakeId={view.lakeId} onClose={() => setTransferring(false)} />}
        {view.grants.length === 0 ? (
          <Typography level="body-sm" textColor="text.tertiary" data-testid="datalake-access-grants-empty">
            No explicit grants. Access follows the channels below.
          </Typography>
        ) : (
          <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
            <Table size="sm" stickyHeader data-testid="datalake-access-grants-table">
              <thead>
                <tr>
                  <th>Principal</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Granted by</th>
                  <th>Granted</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {view.grants.map(g => (
                  <GrantRow key={`${g.principalType}:${g.principalId}`} grant={g} />
                ))}
              </tbody>
            </Table>
          </Sheet>
        )}
      </Box>

      {/* Who can see this: gate-based channels */}
      <Box>
        <Typography level="title-sm" sx={{ mb: 1 }}>
          Access channels
        </Typography>
        {view.channels.length === 0 ? (
          <Typography level="body-sm" textColor="text.tertiary" data-testid="datalake-access-channels-empty">
            Private - reachable only by the owner, managers, and the grants above.
          </Typography>
        ) : (
          <>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }} data-testid="datalake-access-channels">
              {view.channels.map(c => (
                <ChannelChip key={`${c.kind}:${c.value ?? ''}`} channel={c} />
              ))}
            </Box>
            {lakeAccessChannelsComposeConjunctively(view.channels) && (
              <Typography
                level="body-xs"
                textColor="text.tertiary"
                sx={{ mt: 1 }}
                data-testid="datalake-access-channels-compose-note"
              >
                A reader must satisfy all conditions: organization membership is required, and a tag or entitlement
                narrows it further. Effective access is the intersection of these channels, so a member count is an
                upper bound on that channel alone.
              </Typography>
            )}
          </>
        )}
      </Box>

      {/* Who actually read it: audit history */}
      <Box>
        <Typography level="title-sm" sx={{ mb: 0.5 }}>
          Access history
        </Typography>
        {/* Always shown, populated or not: history is a lower bound (only instrumented surfaces emit
            events, and events age out), so neither a row count nor an empty list may be read as the
            complete picture. Stating this only on the empty state would let a populated view read as
            exhaustive. */}
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          sx={{ mb: 1 }}
          data-testid="datalake-access-history-caveat"
        >
          Covers reads through instrumented retrieval surfaces, within the audit retention window. Treat this as a lower
          bound - an empty list is not proof that no one has read this lake.
        </Typography>
        {/* Candidate-cap pressure over the same window. Defensive against a missing object (an older
            server, or a cached response from before the field): the counters carry a "not reported"
            state of their own, so degrading into it is honest rather than a blank. */}
        <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 1 }} data-testid="datalake-access-cap-pressure">
          {!view.candidateCapPressure || view.candidateCapPressure.turnsWithSignal === 0
            ? 'Candidate-cap pressure: not reported for this window.'
            : `Candidate-cap pressure: ${view.candidateCapPressure.turnsAtCap} of ` +
              `${view.candidateCapPressure.turnsWithSignal} reported read(s)` +
              `${view.historyTruncated ? ' in this window' : ''} hit the forced-retrieval candidate cap` +
              `${
                view.candidateCapPressure.lastAtCapAt
                  ? `, most recently ${fmtDateTime(view.candidateCapPressure.lastAtCapAt)}`
                  : ''
              }. A capped read considers only part of the readable library. The cap applies to the whole candidate ` +
              'listing for a turn, so this counts turns that read this lake, not reads this lake caused.'}
        </Typography>
        {view.historyTruncated && (
          <Alert
            size="sm"
            color="warning"
            variant="soft"
            sx={{ mb: 1 }}
            data-testid="datalake-access-history-truncated"
          >
            Showing the most recent reads only - the full trail is longer than this view, and the CSV export carries
            this same window (not the complete trail). Read counts and first-read dates below cover
            {view.windowStartsAt ? ` reads since ${fmtDateTime(view.windowStartsAt)}` : ' this window'}, not all time.
          </Alert>
        )}
        {view.history.length === 0 ? (
          <Typography level="body-sm" textColor="text.tertiary" data-testid="datalake-access-history-empty">
            No reads recorded.
          </Typography>
        ) : (
          <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
            <Table size="sm" stickyHeader data-testid="datalake-access-history-table">
              <thead>
                <tr>
                  <th>Reader</th>
                  <th>Reads</th>
                  <th>Last read</th>
                  <th>Surfaces</th>
                </tr>
              </thead>
              <tbody>
                {view.history.map(h => (
                  <HistoryRow key={`${h.principalKind}:${h.principalId}`} entry={h} />
                ))}
              </tbody>
            </Table>
          </Sheet>
        )}
      </Box>
    </Stack>
  );
}

/**
 * Owner-facing access & membership view (#1672): a manager-only compliance surface answering "who can
 * see this lake" (grants + gate channels) and "who actually read it" (the audit trail), with a CSV
 * export for compliance review. Entry points gate opening this on `canManage`; the server enforces the
 * same, so a non-manager who reached it anyway sees the forbidden state.
 *
 * The VIEW is read-only. Its one write is transferring ownership, which lives here because ownership is
 * the first row of the grants table this shows - and it is gated on the server's own
 * `canTransferOwnership`, which is narrower than the manage gate that opens the modal. The CSV export
 * carries the artifact only, never that per-viewer capability.
 */
export function DataLakeAccessModal({ lake, onClose }: { lake: AccessViewLake | null; onClose: () => void }) {
  const { data, isLoading, isError, error } = useLakeAccessView(lake?.id ?? null, !!lake);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (!lake) return;
    setExporting(true);
    try {
      await downloadLakeAccessCsv(lake.id);
    } catch {
      toast.error('Could not export the access view. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal open={!!lake} onClose={onClose}>
      <ModalDialog
        data-testid="datalake-access-modal"
        sx={{ width: { xs: '95%', md: '52rem' }, maxWidth: '52rem', maxHeight: '90vh', overflow: 'auto' }}
      >
        <ModalClose data-testid="datalake-access-close" />
        <DialogTitle>Access and members{lake ? ` - ${lake.name}` : ''}</DialogTitle>
        <DialogContent>
          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }} data-testid="datalake-access-loading">
              <CircularProgress size="sm" />
            </Box>
          ) : isError ? (
            <Alert color="danger" variant="soft" data-testid="datalake-access-error">
              {/* A 403 here means the caller can read but not manage the lake - the server's manage gate. */}
              {(error as { response?: { status?: number } })?.response?.status === 403
                ? 'You must be able to manage this data lake to view its access.'
                : "Couldn't load the access view. Please try again."}
            </Alert>
          ) : data ? (
            <Stack gap={2}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
                <Typography level="body-xs" textColor="text.tertiary">
                  Generated {fmtDateTime(data.view.generatedAt)}
                </Typography>
                <Button
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  loading={exporting}
                  onClick={handleExport}
                  data-testid="datalake-access-export-btn"
                >
                  Export CSV
                </Button>
              </Box>
              <AccessViewBody view={data.view} canTransferOwnership={data.canTransferOwnership} />
            </Stack>
          ) : null}
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
}

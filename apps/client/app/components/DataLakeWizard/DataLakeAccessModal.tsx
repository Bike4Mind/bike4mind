import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  DialogContent,
  DialogTitle,
  Modal,
  ModalClose,
  ModalDialog,
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
} from '@bike4mind/common';
import { lakeAccessChannelsComposeConjunctively } from '@bike4mind/common';
import type { ColorPaletteProp } from '@mui/joy';
import { useLakeAccessView, downloadLakeAccessCsv } from '@client/app/hooks/data/dataLakes';
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

const CHANNEL_LABEL: Record<LakeAccessChannel['kind'], string> = {
  tag: 'Tag',
  entitlement: 'Entitlement',
  organization: 'Organization',
  public: 'Public',
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
  // Public has no value; org shows its resolved name + member count; tag/entitlement show the gate
  // value and deliberately no count (we never scan the user table to count holders).
  const detail =
    channel.kind === 'public'
      ? 'everyone across the app'
      : channel.kind === 'organization'
        ? `${channel.label ?? channel.value}${channel.holderCount != null ? ` (${channel.holderCount} members)` : ''}`
        : channel.value;
  return (
    <Chip size="md" variant="outlined" color="neutral" data-testid={`datalake-access-channel-${channel.kind}`}>
      {CHANNEL_LABEL[channel.kind]}
      {detail ? `: ${detail}` : ''}
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

function AccessViewBody({ view }: { view: LakeAccessView }) {
  return (
    <Stack gap={3} data-testid="datalake-access-body">
      {/* Who can see this: explicit grants */}
      <Box>
        <Typography level="title-sm" sx={{ mb: 1 }}>
          Members and grants
        </Typography>
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
        <Typography level="title-sm" sx={{ mb: 1 }}>
          Access history
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
            No recorded reads yet.
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
 * Owner-facing access & membership view (#1672): a manager-only, read-only compliance surface
 * answering "who can see this lake" (grants + gate channels) and "who actually read it" (the audit
 * trail), with a CSV export for compliance review. Entry points gate opening this on `canManage`;
 * the server enforces the same, so a non-manager who reached it anyway sees the forbidden state.
 */
export function DataLakeAccessModal({ lake, onClose }: { lake: AccessViewLake | null; onClose: () => void }) {
  const { data: view, isLoading, isError, error } = useLakeAccessView(lake?.id ?? null, !!lake);
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
          ) : view ? (
            <Stack gap={2}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
                <Typography level="body-xs" textColor="text.tertiary">
                  Generated {fmtDateTime(view.generatedAt)}
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
              <AccessViewBody view={view} />
            </Stack>
          ) : null}
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
}

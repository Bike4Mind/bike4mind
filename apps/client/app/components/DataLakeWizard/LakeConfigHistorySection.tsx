import React from 'react';
import { Alert, Box, Chip, CircularProgress, Sheet, Stack, Table, Typography } from '@mui/joy';
import type { ColorPaletteProp } from '@mui/joy';
import type {
  LakeConfigChangeAction,
  LakeConfigChangeField,
  LakeConfigHistoryEntry,
  LakeConfigHistoryFieldChange,
  LakeConfigHistoryFingerprintChange,
  LakeConfigHistoryView,
  LakeConfigLiteralValue,
  LakeManageRung,
} from '@bike4mind/common';

/**
 * Human labels for every audited field. A TOTAL map, like the producer-side
 * `LAKE_CONFIG_FIELD_AUDIT`: a newly audited field that nobody labels here is a COMPILE error rather
 * than a history row reading `requiredPassageTokenTarget` at an owner.
 */
const FIELD_LABEL: Record<LakeConfigChangeField, string> = {
  name: 'Name',
  slug: 'Slug',
  description: 'Description',
  systemPrompt: 'System prompt',
  preferredSystemPromptId: 'Preferred system prompt',
  groundingMode: 'Grounding mode',
  requiredPassageTokenTarget: 'Passage token target',
  fileTagPrefix: 'File tag prefix',
  datalakeTag: 'Data lake tag',
  requiredUserTag: 'Required user tag',
  requiredEntitlement: 'Required entitlement',
  organizationId: 'Organization',
  isPublic: 'Public',
  auditQueryTextEnabled: 'Query-text auditing',
  status: 'Status',
  createdByUserId: 'Created by',
  effectiveOwnerUserId: 'Owner',
};

/** Total, for the same reason as FIELD_LABEL. */
const ACTION_LABEL: Record<LakeConfigChangeAction, string> = {
  update: 'Settings updated',
  visibility: 'Visibility changed',
  'transfer-ownership': 'Ownership transferred',
  archive: 'Archived',
  unarchive: 'Unarchived',
  delete: 'Deleted',
  restore: 'Restored',
  'auto-activate': 'Activated automatically',
};

/**
 * Total. `platform-admin` is the one rung rendered as a WARNING: every other rung belongs to someone
 * with a standing relationship to the lake, so a support-side edit is the case an owner most needs to
 * spot in this list - which is the whole reason the producer records the rung at all.
 */
const RUNG_LABEL: Record<LakeManageRung, { label: string; color: ColorPaletteProp }> = {
  'platform-admin': { label: 'Platform admin', color: 'warning' },
  'grant-owner': { label: 'Owner', color: 'primary' },
  creator: { label: 'Creator', color: 'primary' },
  'grant-curator': { label: 'Curator', color: 'success' },
  'org-admin': { label: 'Org admin', color: 'neutral' },
  'org-grant': { label: 'Org grant', color: 'neutral' },
  system: { label: 'System', color: 'neutral' },
};

const fmtDateTime = (d: Date | string): string =>
  new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const fmtDate = (d: Date | string): string => new Date(d).toLocaleDateString(undefined, { dateStyle: 'medium' });

/**
 * One side of a bounded field's move. An ABSENT key means the field was unset on that side - the
 * producer's way of recording a set or a clear without a sentinel - so it renders as "not set"
 * rather than as an empty cell a reader would mistake for a rendering bug.
 */
export function describeLakeConfigValue(
  value: LakeConfigLiteralValue | undefined,
  /** Resolves a user id to a display name; absent ids fall back to the raw id. */
  userNames?: Record<string, string>
): string {
  if (value === undefined || value === null || value === '') return 'not set';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  const raw = String(value);
  if (!userNames) return raw;
  // Comma-joined because a transfer records the whole prior-owner set in one scalar - see
  // ownershipChange. Each part degrades to its own raw id, so one unresolvable member of the set
  // does not take the resolvable ones down with it.
  return raw
    .split(',')
    .map(part => userNames[part] ?? part)
    .join(', ');
}

/**
 * A long free-text field's move, described WITHOUT reproducing it - the whole point of the
 * fingerprint form. Lengths are code points, as stored.
 *
 * `textUnchanged` is resolved server-side (the client never sees the hashes it was derived from):
 * it means the trimmed text is identical, so the recorded move was whitespace-only. Saying
 * "formatting only" is more honest than "replaced", which would send an owner hunting for a change
 * to the prompt's meaning that never happened.
 */
export function describeLakeConfigFingerprint(change: LakeConfigHistoryFingerprintChange): string {
  const { beforeFingerprint: before, afterFingerprint: after } = change;
  if (!before.present && !after.present) return 'still not set';
  if (!before.present) return `set (${after.length} chars)`;
  if (!after.present) return `cleared (was ${before.length} chars)`;
  if (change.textUnchanged) return `formatting only (${after.length} chars)`;
  return `replaced (${before.length} -> ${after.length} chars)`;
}

/** The right-hand cell for one changed field, per arm of the discriminated union. */
/** The fields whose values are user ids - the only ones a name lookup may be applied to. Must stay
 *  in sync with IDENTITY_VALUE_FIELDS in assembleLakeConfigHistory, which decides what gets
 *  resolved server-side; a field listed here but not there simply renders its raw id. */
const IDENTITY_VALUE_FIELDS = new Set<LakeConfigChangeField>(['effectiveOwnerUserId', 'createdByUserId']);

export function describeLakeConfigChange(
  change: LakeConfigHistoryFieldChange,
  userNames?: Record<string, string>
): string {
  if (change.kind === 'fingerprint') {
    return describeLakeConfigFingerprint(change);
  }
  const names = IDENTITY_VALUE_FIELDS.has(change.field) ? userNames : undefined;
  const clipped = change.truncated ? ' (clipped)' : '';
  return `${describeLakeConfigValue(change.before, names)} -> ${describeLakeConfigValue(change.after, names)}${clipped}`;
}

/**
 * Label lookups that DEGRADE rather than throw. The maps above are total over today's vocabulary and
 * must stay that way - that compile guard is the point - but these rows are retained for 1095-3650
 * days, so a row can outlive the enum that named it (a rung renamed or dropped in a later release).
 * An unguarded `RUNG_LABEL[...]` would then return undefined and `.label` would throw, taking the
 * WHOLE history table down; the honest fallback is to show the raw stored value.
 */
const rungLabel = (rung: LakeManageRung): { label: string; color: ColorPaletteProp } =>
  RUNG_LABEL[rung] ?? { label: rung, color: 'neutral' };

const fieldLabel = (field: LakeConfigChangeField): string => FIELD_LABEL[field] ?? field;

const actionLabel = (action: LakeConfigChangeAction): string => ACTION_LABEL[action] ?? action;

function ChangeRow({ entry, userNames }: { entry: LakeConfigHistoryEntry; userNames: Record<string, string> }) {
  const rung = rungLabel(entry.manageRung);
  return (
    <tr data-testid="datalake-config-history-row">
      <td>
        <Typography level="body-sm">{fmtDateTime(entry.changedAt)}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {actionLabel(entry.action)}
        </Typography>
      </td>
      <td>
        <Typography level="body-sm">{entry.principalName ?? entry.principalId}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {entry.principalKind}
          {entry.onBehalfOfUserId ? ` (for ${entry.onBehalfOfName ?? entry.onBehalfOfUserId})` : ''}
        </Typography>
      </td>
      <td>
        <Chip
          size="sm"
          variant="soft"
          color={rung.color}
          data-testid={`datalake-config-history-rung-${entry.manageRung}`}
        >
          {rung.label}
        </Chip>
      </td>
      <td>
        <Stack gap={0.5}>
          {entry.changes.map((change, i) => (
            <Box key={`${change.field}-${i}`} data-testid="datalake-config-history-change">
              <Typography level="body-xs" fontWeight="lg">
                {fieldLabel(change.field)}
              </Typography>
              <Typography level="body-xs" textColor="text.tertiary">
                {describeLakeConfigChange(change, userNames)}
              </Typography>
            </Box>
          ))}
        </Stack>
      </td>
    </tr>
  );
}

export interface LakeConfigHistorySectionProps {
  view: LakeConfigHistoryView | undefined;
  isLoading: boolean;
  error: unknown;
}

/**
 * The owner-facing config-change history for one lake (#1769): who changed how this lake answers,
 * what moved, and which manage rung authorized it.
 *
 * Purely presentational - all data arrives via props, no fetching here - so it needs no
 * QueryClientProvider in tests, and it can be mounted from any surface that already holds the view
 * (today the settings modal; the owner access panel once #1672 lands).
 */
export function LakeConfigHistorySection({ view, isLoading, error }: LakeConfigHistorySectionProps) {
  return (
    <Box data-testid="datalake-config-history-section">
      <Typography level="title-sm" sx={{ mb: 1 }}>
        Recent configuration changes
      </Typography>

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }} data-testid="datalake-config-history-loading">
          <CircularProgress size="sm" />
        </Box>
      ) : error ? (
        <Alert color="danger" size="sm" data-testid="datalake-config-history-error">
          Could not load this data lake&apos;s configuration history. Try again shortly.
        </Alert>
      ) : !view || view.entries.length === 0 ? (
        // Worded for the case that will be COMMON for a while: auditing started when this feature
        // shipped, so a long-lived lake legitimately shows nothing. "No changes recorded" would read
        // as "nothing has ever changed", which for such a lake is simply false.
        <Typography level="body-sm" textColor="text.tertiary" data-testid="datalake-config-history-empty">
          No configuration changes have been recorded for this data lake yet. Changes are recorded from the point
          auditing was enabled, so edits made before then do not appear here.
        </Typography>
      ) : (
        <Stack gap={1}>
          <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
            <Table size="sm" stickyHeader data-testid="datalake-config-history-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Authorized as</th>
                  <th>What changed</th>
                </tr>
              </thead>
              <tbody>
                {view.entries.map(entry => (
                  <ChangeRow key={entry.eventId} entry={entry} userNames={view.userNames} />
                ))}
              </tbody>
            </Table>
          </Sheet>
          {view.truncated && (
            <Typography level="body-xs" textColor="text.tertiary" data-testid="datalake-config-history-truncated">
              Showing the {view.entries.length} most recent changes
              {view.windowStartsAt ? `, back to ${fmtDate(view.windowStartsAt)}` : ''}. Older changes are not shown.
            </Typography>
          )}
        </Stack>
      )}
    </Box>
  );
}

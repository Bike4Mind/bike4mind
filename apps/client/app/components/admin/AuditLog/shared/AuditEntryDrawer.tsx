import { Box, Drawer, IconButton, Link, Stack, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import type { AuditEntry } from '@bike4mind/common';
import { AuditActorLabel } from './AuditActorLabel';
import { AuditSeverityChip } from './AuditSeverityChip';
import { auditTargetHref } from './auditTargetHref';
import {
  ChangesTable,
  CollapsibleJson,
  CopyableId,
  DrawerSection,
  KeyValueRows,
  RelatedEventRow,
} from './AuditEntryDrawerSections';

export type AuditEntryDrawerProps = {
  /** The caller resolves the entry; this component fetches nothing. */
  entry: AuditEntry | null;
  onClose(): void;
  /** Section is hidden when undefined or empty. */
  relatedEntries?: AuditEntry[];
  onSelectRelated?(entry: AuditEntry): void;
  /** Hidden when undefined. */
  openInAuditLogHref?: string;
};

export const AuditEntryDrawer: React.FC<AuditEntryDrawerProps> = ({
  entry,
  onClose,
  relatedEntries,
  onSelectRelated,
  openInAuditLogHref,
}) => (
  <Drawer open={entry !== null} onClose={onClose} anchor="right" size="md">
    {entry && (
      <Box data-testid="audit-drawer" sx={{ p: 2, overflow: 'auto' }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
          <Stack spacing={0.5}>
            <Typography level="title-md">{entry.summary}</Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <AuditSeverityChip severity={entry.severity} />
              <Typography level="body-xs">
                {entry.action} - {new Date(entry.occurredAt).toLocaleString()}
              </Typography>
            </Stack>
          </Stack>
          <IconButton aria-label="Close" onClick={onClose} data-testid="audit-drawer-close-btn">
            <CloseIcon />
          </IconButton>
        </Stack>

        <Stack spacing={2}>
          {openInAuditLogHref && (
            <Link href={openInAuditLogHref} data-testid="audit-drawer-open-in-log-link">
              Open in Audit Log
            </Link>
          )}

          <DrawerSection title="Actor">
            <AuditActorLabel actor={entry.actor} />
            <KeyValueRows
              rows={[
                ['Email', entry.actor.email],
                ['User ID', entry.actor.userId],
                ['API key ID', entry.actor.apiKeyId],
                ['Kind', entry.actor.kind],
                ['Scope', entry.actor.scope],
                ['Was admin', String(entry.actor.wasAdmin)],
                ['Impersonating', entry.actor.impersonatedUserId],
              ]}
            />
          </DrawerSection>

          <DrawerSection title="Target">
            {auditTargetHref(entry.target) && (
              <Link href={auditTargetHref(entry.target)} data-testid="audit-drawer-target-link">
                Open affected record
              </Link>
            )}
            <KeyValueRows
              rows={[
                ['Name', entry.target.displayName],
                ['Kind', entry.target.kind],
                ['ID', entry.target.id],
              ]}
            />
          </DrawerSection>

          {entry.changes && entry.changes.length > 0 && (
            <DrawerSection title="Changes">
              <ChangesTable changes={entry.changes} />
            </DrawerSection>
          )}

          {entry.reason && (
            <DrawerSection title="Reason">
              <Typography level="body-sm">{entry.reason}</Typography>
            </DrawerSection>
          )}

          <DrawerSection title="Request context">
            <KeyValueRows
              rows={[
                ['IP', entry.context.ip],
                ['User agent', entry.context.userAgent],
                ['Request ID', entry.context.requestId],
                ['Source', entry.context.source],
                ['Route', entry.context.route],
              ]}
            />
          </DrawerSection>

          {entry.related?.creditTransactionId && (
            <DrawerSection title="Related IDs">
              <CopyableId label="Credit transaction" value={entry.related.creditTransactionId} />
            </DrawerSection>
          )}

          {entry.details && Object.keys(entry.details).length > 0 && (
            <DrawerSection title="Details">
              <CollapsibleJson value={entry.details} />
            </DrawerSection>
          )}

          {relatedEntries && relatedEntries.length > 0 && (
            <DrawerSection title="Related events">
              <Stack spacing={1}>
                {relatedEntries.map(related => (
                  <RelatedEventRow key={related.id} entry={related} onSelect={onSelectRelated} />
                ))}
              </Stack>
            </DrawerSection>
          )}
        </Stack>
      </Box>
    )}
  </Drawer>
);

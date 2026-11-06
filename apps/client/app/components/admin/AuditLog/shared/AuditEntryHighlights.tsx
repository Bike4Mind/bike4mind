import { Chip, Stack, Tooltip, Typography } from '@mui/joy';
import type { AuditEntry } from '@bike4mind/common';
import { auditKeyContext, isSelfTargeted } from './auditEntryContext';

const SELF_TARGETED_HINT = 'The admin performed this action on their own account.';

/** Self-targeted marker for a critical entry: the case a second admin most needs to notice. */
export const AuditSelfTargetedChip = ({ entry, testIdPrefix }: { entry: AuditEntry; testIdPrefix: string }) => {
  if (entry.severity !== 'critical' || !isSelfTargeted(entry)) return null;
  return (
    <Tooltip title={SELF_TARGETED_HINT}>
      <Chip size="sm" variant="soft" color="warning" data-testid={`${testIdPrefix}-self-targeted-chip`}>
        Self-targeted
      </Chip>
    </Tooltip>
  );
};

/**
 * Key name and scopes under an API key entry's summary. Admin-provisioned scopes also spell out what
 * they allow, since that is what a reviewer has to judge; the rest keep it in a tooltip.
 */
export const AuditKeyDetails = ({ entry, testIdPrefix }: { entry: AuditEntry; testIdPrefix: string }) => {
  const context = auditKeyContext(entry);
  if (!context) return null;
  const privileged = context.scopes.filter(scope => scope.adminProvisioned && scope.description);
  return (
    <Stack spacing={0.5} data-testid={`${testIdPrefix}-key-details`}>
      <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
        {context.name && (
          <Typography level="body-xs" data-testid={`${testIdPrefix}-key-name`}>
            Key &quot;{context.name}&quot;
          </Typography>
        )}
        {context.scopes.map(scope => (
          <Tooltip key={scope.value} title={scope.description ? `${scope.value}: ${scope.description}` : scope.value}>
            <Chip
              size="sm"
              variant={scope.adminProvisioned ? 'soft' : 'outlined'}
              color={scope.adminProvisioned ? 'warning' : 'neutral'}
              data-testid={`${testIdPrefix}-key-scope-${scope.value}`}
            >
              {scope.label}
            </Chip>
          </Tooltip>
        ))}
      </Stack>
      {privileged.map(scope => (
        <Typography
          key={scope.value}
          level="body-xs"
          data-testid={`${testIdPrefix}-key-scope-description-${scope.value}`}
        >
          {scope.label}: {scope.description}
        </Typography>
      ))}
    </Stack>
  );
};

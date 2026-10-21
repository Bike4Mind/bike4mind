import { Chip } from '@mui/joy';
import type { AuditEntry } from '@bike4mind/common';

const SEVERITY_COLOR: Record<AuditEntry['severity'], 'neutral' | 'warning' | 'danger'> = {
  info: 'neutral',
  notice: 'warning',
  critical: 'danger',
};

export const AuditSeverityChip: React.FC<{ severity: AuditEntry['severity'] }> = ({ severity }) => (
  <Chip size="sm" variant="soft" color={SEVERITY_COLOR[severity]} data-testid="audit-severity-chip">
    {severity}
  </Chip>
);

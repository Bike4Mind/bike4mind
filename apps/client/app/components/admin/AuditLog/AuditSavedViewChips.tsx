import { Button, Stack } from '@mui/joy';
import type { AuditLogFilters } from '@bike4mind/common';
import { activeSavedViewKey, AUDIT_SAVED_VIEWS } from './auditSavedViews';

type AuditSavedViewChipsProps = { filters: AuditLogFilters; onSelect(filters: AuditLogFilters): void };

export const AuditSavedViewChips: React.FC<AuditSavedViewChipsProps> = ({ filters, onSelect }) => {
  const activeKey = activeSavedViewKey(filters);
  return (
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" data-testid="audit-saved-views">
      {AUDIT_SAVED_VIEWS.map(view => (
        <Button
          key={view.key}
          size="sm"
          variant={activeKey === view.key ? 'solid' : 'outlined'}
          color={activeKey === view.key ? 'primary' : 'neutral'}
          aria-pressed={activeKey === view.key}
          onClick={() => onSelect(view.filters)}
          data-testid={`audit-saved-view-${view.key}`}
          sx={{ borderRadius: 'xl' }}
        >
          {view.label}
        </Button>
      ))}
    </Stack>
  );
};

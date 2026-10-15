import { Box, Button, Chip, Stack, Tooltip, Typography } from '@mui/joy';
import CheckIcon from '@mui/icons-material/Check';
import type { DerivedIntegrationStatus, IntegrationId } from '@bike4mind/common';
import { useToggleIntegrationRequest } from '@client/app/hooks/data/integrationRequests';
import { STATUS_LABELS } from './galleryModel';

export const ADMIN_ONLY_NOTE = 'Only admins can see this';

/**
 * A status as a dot and a word. Only Connected takes the accent; the rest step down in ink,
 * and Coming soon's dashed ring reads as not-yet even without colour.
 */
export const IntegrationStatusLabel = ({ derived, testId }: { derived: DerivedIntegrationStatus; testId?: string }) => {
  const { status, betaTag, adminOnly } = derived;
  const color =
    status === 'connected' ? 'primary.plainColor' : status === 'coming-soon' ? 'text.tertiary' : 'text.secondary';
  return (
    <Stack direction="row" alignItems="center" gap="6px" sx={{ minWidth: 0 }} data-testid={testId} data-status={status}>
      <Box
        component="span"
        aria-hidden
        sx={{
          width: '8px',
          height: '8px',
          flexShrink: 0,
          borderRadius: '50%',
          border: '1.5px solid currentColor',
          borderStyle: status === 'coming-soon' ? 'dashed' : 'solid',
          color,
          backgroundColor: status === 'connected' || status === 'beta' ? 'currentColor' : 'transparent',
        }}
      />
      <Typography level="body-sm" noWrap sx={{ fontSize: '12.5px', fontWeight: 500, color }}>
        {STATUS_LABELS[status]}
      </Typography>
      {betaTag && (
        <Chip size="sm" variant="outlined" color="neutral" sx={{ '--Chip-minHeight': '18px', fontSize: '11px' }}>
          Beta
        </Chip>
      )}
      {adminOnly && (
        <Tooltip title={ADMIN_ONLY_NOTE} size="sm">
          <Chip
            size="sm"
            variant="soft"
            color="neutral"
            aria-label={ADMIN_ONLY_NOTE}
            sx={{ '--Chip-minHeight': '18px', fontSize: '11px' }}
          >
            Admin
          </Chip>
        </Tooltip>
      )}
    </Stack>
  );
};

/**
 * File or withdraw the viewer's request for a roadmap entry. Disabled while a toggle for the
 * same entry is in flight, from this button or any other for that entry. `onToggle` hears the
 * click with the state before it, for analytics; the request itself is made here.
 */
export const RequestButton = ({
  integrationId,
  requested,
  onToggle,
  testId,
}: {
  integrationId: IntegrationId;
  requested: boolean;
  onToggle?: (integrationId: IntegrationId, requested: boolean) => void;
  testId: string;
}) => {
  const { toggle, isPending } = useToggleIntegrationRequest(integrationId);
  return (
    <Button
      size="sm"
      variant="outlined"
      color="neutral"
      aria-pressed={requested}
      disabled={isPending}
      startDecorator={requested ? <CheckIcon sx={{ fontSize: '16px' }} /> : undefined}
      data-testid={testId}
      onClick={event => {
        event.stopPropagation();
        onToggle?.(integrationId, requested);
        toggle({ requested });
      }}
      sx={{ '--Button-minHeight': '28px', fontWeight: 500, whiteSpace: 'nowrap' }}
    >
      {requested ? 'Requested' : 'Request'}
    </Button>
  );
};

export const requestCountText = (count: number): string => `${count} ${count === 1 ? 'request' : 'requests'}`;

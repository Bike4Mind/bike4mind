import { Avatar, Chip, Stack, Tooltip, Typography } from '@mui/joy';
import type { AuditActor } from '@bike4mind/common';

export const AuditActorLabel: React.FC<{ actor: AuditActor }> = ({ actor }) => (
  <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
    <Avatar size="sm">{actor.name.charAt(0).toUpperCase()}</Avatar>
    <Typography level="body-sm" noWrap title={actor.email}>
      {actor.name}
    </Typography>
    {actor.impersonatedUserId && (
      <Tooltip title={actor.impersonatedUserId}>
        <Chip size="sm" variant="outlined" color="warning" data-testid="audit-actor-impersonation-chip">
          as user
        </Chip>
      </Tooltip>
    )}
  </Stack>
);

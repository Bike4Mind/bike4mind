import { FC } from 'react';
import { Box, Card, CircularProgress, Switch, Typography } from '@mui/joy';
import { useSetTutorialsSwitch, useTutorialsSwitch } from '@client/app/hooks/tutorials/useTutorialsSwitch';

export const DEFAULT_SWITCH_TITLE = 'Guided tutorials';
export const DEFAULT_SWITCH_DESCRIPTION = 'Show the guided tutorials to the users who can see them while this is on.';

interface Props {
  apiBase: string;
  /** The host's own name for its tutorials and who sees them. */
  title?: string;
  description?: string;
}

/** Admin card for a host's guided tutorials switch. */
const TutorialsSwitchCard: FC<Props> = ({
  apiBase,
  title = DEFAULT_SWITCH_TITLE,
  description = DEFAULT_SWITCH_DESCRIPTION,
}) => {
  const current = useTutorialsSwitch(apiBase);
  const save = useSetTutorialsSwitch(apiBase);
  const enabled = current.data === true;

  return (
    <Card variant="outlined" data-testid="tutorials-switch-card">
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
        <Box>
          <Typography level="title-md">{title}</Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary', mt: 0.5 }}>
            {description}
          </Typography>
        </Box>
        {current.isLoading ? (
          <CircularProgress size="sm" />
        ) : (
          <Switch
            checked={enabled}
            disabled={current.isError || save.isPending}
            onChange={event => save.mutate(event.target.checked)}
            slotProps={{
              input: { 'aria-label': title, 'data-testid': 'tutorials-switch' } as Record<string, unknown>,
            }}
          />
        )}
      </Box>
      {current.isError && (
        <Typography level="body-sm" color="danger">
          Could not read the tutorials switch.
        </Typography>
      )}
    </Card>
  );
};

export default TutorialsSwitchCard;

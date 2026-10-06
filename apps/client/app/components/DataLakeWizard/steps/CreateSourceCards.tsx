import { Box, Card, Stack, Tooltip, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useOfferedCreateLakeSources } from '@client/app/components/datalake/createLakeSources';

/**
 * "Where's your content?" - the first question the create wizard asks, one card per source from the
 * create registry (createLakeSources). Picking a card records the source on the wizard store, which
 * is what decides the new lake's origin and which panel the step then shows.
 *
 * A source whose flag is off is absent entirely; one the current account scope cannot use is shown
 * disabled with its reason, so the capability stays discoverable where it cannot be used.
 */
export default function CreateSourceCards() {
  const theme = useTheme();
  const setCreateSource = useDataLakeWizardStore(s => s.setCreateSource);
  const offered = useOfferedCreateLakeSources();

  return (
    <Stack gap={2} data-testid="create-source-cards">
      <Box>
        <Typography level="h4">Where&apos;s your content?</Typography>
        <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
          Pick where this data lake gets its files from. You can add more later.
        </Typography>
      </Box>

      <Stack direction="row" gap={2} flexWrap="wrap">
        {offered.map(({ source, availability }) => {
          const disabled = availability.status === 'disabled';
          const { Icon } = source;
          const card = (
            <Card
              component="button"
              type="button"
              variant="outlined"
              disabled={disabled}
              data-testid={`create-source-card-${source.kind}`}
              onClick={() => !disabled && setCreateSource(source.kind)}
              sx={{
                width: 220,
                textAlign: 'left',
                alignItems: 'flex-start',
                gap: 1,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.6 : 1,
                borderColor: 'divider',
                bgcolor: theme.palette.mode === 'dark' ? 'neutral.900' : 'background.surface',
                '&:hover': disabled ? undefined : { borderColor: 'primary.500' },
              }}
            >
              <Icon />
              <Typography level="title-sm">{source.label}</Typography>
              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                {source.hint}
              </Typography>
              {disabled && (
                <Typography
                  level="body-xs"
                  sx={{ color: 'warning.plainColor' }}
                  data-testid={`create-source-reason-${source.kind}`}
                >
                  {availability.reason}
                </Typography>
              )}
            </Card>
          );

          // The reason is rendered on the card itself (a tooltip alone is unreachable by keyboard
          // and invisible on touch); the tooltip just repeats it for a card clipped by the layout.
          return (
            <Box key={source.kind}>
              {disabled ? (
                <Tooltip title={availability.reason}>
                  <span>{card}</span>
                </Tooltip>
              ) : (
                card
              )}
            </Box>
          );
        })}
      </Stack>
    </Stack>
  );
}

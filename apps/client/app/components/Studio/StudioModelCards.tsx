import { Box, Chip, Radio, RadioGroup, Sheet, Stack, Typography } from '@mui/joy';
import { formatCredits } from '@client/app/utils/formatUsd';

export type StudioModelCard = {
  id: string;
  name: string;
  provider: string;
  strength: string;
  // Indicative credits for one output (each medium says at which settings), or null when it cannot be priced.
  creditsPerOutput: number | null;
  // What one output is called, mid-sentence: "image", "clip", "song".
  outputNoun: string;
  // What the model can do, e.g. "Generate", "Edit".
  modes: readonly string[];
  // The model cannot run at all right now, so the card cannot be picked.
  unavailableReason: string | null;
  // The model cannot make the current request. Still pickable: picking it marks the controls that do not fit.
  mismatchReason: string | null;
};

type StudioModelCardsProps = {
  // `<prefix>-model-cards`, `<prefix>-model-card-<id>`, `-radio` and `-reason` on each card.
  testIdPrefix: string;
  cards: readonly StudioModelCard[];
  selectedId: string;
  onSelect: (modelId: string) => void;
};

const costLine = ({ creditsPerOutput, outputNoun }: StudioModelCard): string =>
  creditsPerOutput === null
    ? 'Price unavailable'
    : `About ${formatCredits(creditsPerOutput)} credits per ${outputNoun}`;

/**
 * The model picker as cards: every model is visible with what it is good at, what it costs and what it can do, and
 * one is always selected, so the default is a visible, swappable choice rather than a hidden auto-pick.
 */
const StudioModelCards = ({ testIdPrefix, cards, selectedId, onSelect }: StudioModelCardsProps) => (
  <RadioGroup
    aria-label="Model"
    value={selectedId}
    onChange={event => onSelect(event.target.value)}
    data-testid={`${testIdPrefix}-model-cards`}
    sx={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
      gap: 1.5,
      // RadioGroup adds a margin between its children; the grid gap spaces them instead.
      '& > *': { m: 0 },
    }}
  >
    {cards.map(card => {
      const selected = card.id === selectedId;
      const reason = card.unavailableReason ?? card.mismatchReason;
      const testId = `${testIdPrefix}-model-card-${card.id}`;
      return (
        <Sheet
          key={card.id}
          variant={selected ? 'soft' : 'outlined'}
          color={selected ? 'primary' : 'neutral'}
          data-testid={testId}
          data-selected={selected}
          sx={{
            p: 1.5,
            borderRadius: 'md',
            position: 'relative',
            opacity: reason && !selected ? 0.6 : 1,
            outline: selected ? '2px solid' : 'none',
            outlineColor: 'primary.outlinedBorder',
          }}
        >
          <Stack gap={0.75}>
            <Stack direction="row" gap={1} alignItems="flex-start" justifyContent="space-between">
              <Radio
                overlay
                value={card.id}
                disabled={card.unavailableReason !== null}
                label={card.name}
                slotProps={{
                  label: { sx: { fontWeight: 'lg' } },
                  input: { 'data-testid': `${testId}-radio` },
                }}
              />
              <Chip size="sm" variant="outlined">
                {card.provider}
              </Chip>
            </Stack>
            <Typography level="body-xs">{card.strength}</Typography>
            <Typography level="body-xs" fontWeight="md" data-testid={`${testId}-cost`}>
              {costLine(card)}
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              {card.modes.map(mode => (
                <Chip key={mode} size="sm" variant="soft">
                  {mode}
                </Chip>
              ))}
            </Box>
            {reason && (
              <Typography
                level="body-xs"
                color={card.unavailableReason ? 'neutral' : 'warning'}
                data-testid={`${testId}-reason`}
              >
                {reason}
              </Typography>
            )}
          </Stack>
        </Sheet>
      );
    })}
  </RadioGroup>
);

export default StudioModelCards;

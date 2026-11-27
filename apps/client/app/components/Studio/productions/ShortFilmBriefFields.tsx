import { Button, Checkbox, Input, Stack, ToggleButtonGroup, Typography } from '@mui/joy';
import {
  STUDIO_COMPOSITION_LIMITS,
  STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS,
  STUDIO_SHORT_FILM_ASPECTS,
  STUDIO_SHORT_FILM_LENGTHS_MS,
  defaultStudioTimeline,
  type StudioCompositionCreateBody,
  type StudioOutputAspectRatio,
} from '@bike4mind/common';
import { StudioSectionLabel } from '../design/StudioPanel';

export type ShortFilmBrief = {
  premise: string;
  tone: string;
  durationMs: number;
  aspects: StudioOutputAspectRatio[];
};

const { durationMs: DEFAULT_LENGTH_MS, aspects: DEFAULT_ASPECTS } = STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS.short_film;

export const initialShortFilmBrief = (): ShortFilmBrief => ({
  premise: '',
  tone: '',
  durationMs: DEFAULT_LENGTH_MS,
  aspects: [...DEFAULT_ASPECTS],
});

/** The brief and sized timeline a short film is created with; empty text fields are left out. */
export const shortFilmCreateFields = ({
  premise,
  tone,
  durationMs,
  aspects,
}: ShortFilmBrief): Pick<StudioCompositionCreateBody, 'brief' | 'timeline'> => ({
  brief: {
    ...(premise.trim() && { summary: premise.trim() }),
    ...(tone.trim() && { tone: tone.trim() }),
  },
  timeline: defaultStudioTimeline('short_film', { durationMs, aspects }),
});

const lengthLabel = (durationMs: number) =>
  durationMs % 60_000 === 0 ? `${durationMs / 60_000} min` : `${durationMs / 1000}s`;

type ShortFilmBriefFieldsProps = {
  value: ShortFilmBrief;
  onChange: (next: ShortFilmBrief) => void;
};

/** The Short film template's brief on the Productions home: premise, tone, length and output sizes. */
const ShortFilmBriefFields = ({ value, onChange }: ShortFilmBriefFieldsProps) => {
  // Kept in the shared order, so the outputs (and the editor's first, previewed one) do not depend on click order.
  const toggleAspect = (aspect: StudioOutputAspectRatio) =>
    onChange({
      ...value,
      aspects: STUDIO_SHORT_FILM_ASPECTS.filter(option =>
        option === aspect ? !value.aspects.includes(option) : value.aspects.includes(option)
      ),
    });

  return (
    <Stack spacing={1.5} data-testid="productions-short-film-brief">
      <Stack spacing={0.5}>
        <StudioSectionLabel htmlFor="productions-short-film-premise">Premise</StudioSectionLabel>
        <Input
          size="sm"
          id="productions-short-film-premise"
          placeholder="A lighthouse keeper finds a message in a bottle addressed to her"
          value={value.premise}
          onChange={event => onChange({ ...value, premise: event.target.value })}
          slotProps={{
            input: {
              maxLength: STUDIO_COMPOSITION_LIMITS.briefSummaryMaxLength,
              'data-testid': 'productions-short-film-premise-input',
            },
          }}
        />
      </Stack>
      <Stack spacing={0.5}>
        <StudioSectionLabel htmlFor="productions-short-film-tone">Tone</StudioSectionLabel>
        <Input
          size="sm"
          id="productions-short-film-tone"
          placeholder="Wistful, quiet, hopeful"
          value={value.tone}
          onChange={event => onChange({ ...value, tone: event.target.value })}
          slotProps={{
            input: {
              maxLength: STUDIO_COMPOSITION_LIMITS.briefFieldMaxLength,
              'data-testid': 'productions-short-film-tone-input',
            },
          }}
        />
      </Stack>
      <Stack spacing={0.5}>
        <StudioSectionLabel>Length</StudioSectionLabel>
        <ToggleButtonGroup
          size="sm"
          value={String(value.durationMs)}
          onChange={(_event, next) => {
            if (next) onChange({ ...value, durationMs: Number(next) });
          }}
          aria-label="Length"
          data-testid="productions-short-film-length"
        >
          {STUDIO_SHORT_FILM_LENGTHS_MS.map(durationMs => (
            <Button
              key={durationMs}
              value={String(durationMs)}
              data-testid={`productions-short-film-length-${durationMs / 1000}s`}
            >
              {lengthLabel(durationMs)}
            </Button>
          ))}
        </ToggleButtonGroup>
      </Stack>
      <Stack spacing={0.5}>
        <StudioSectionLabel>Sizes</StudioSectionLabel>
        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
          {STUDIO_SHORT_FILM_ASPECTS.map(aspect => (
            <Checkbox
              key={aspect}
              size="sm"
              label={aspect}
              checked={value.aspects.includes(aspect)}
              onChange={() => toggleAspect(aspect)}
              slotProps={{
                input: { 'data-testid': `productions-short-film-aspect-${aspect.replace(':', 'x')}-checkbox` },
              }}
            />
          ))}
        </Stack>
        {value.aspects.length === 0 && (
          <Typography level="body-xs" color="danger" data-testid="productions-short-film-aspects-error">
            Pick at least one size.
          </Typography>
        )}
      </Stack>
    </Stack>
  );
};

export default ShortFilmBriefFields;

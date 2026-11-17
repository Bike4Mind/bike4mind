import { Button, Input, Stack } from '@mui/joy';
import {
  STUDIO_COMPOSITION_LIMITS,
  type StudioCompositionBrief,
  type StudioCompositionResponse,
} from '@bike4mind/common';
import { StudioPanel, StudioSectionLabel } from '../design/StudioPanel';
import FieldSaveStatus from './FieldSaveStatus';
import LibraryThumb from './LibraryThumb';
import { useFieldAutosave } from './useFieldAutosave';
import { useLibraryPicker } from './useLibraryPicker';

type BriefTextField = 'summary' | 'audience' | 'callToAction';

const TEXT_FIELDS: { field: BriefTextField; label: string; placeholder: string; maxLength: number }[] = [
  {
    field: 'summary',
    label: 'The idea',
    placeholder: 'Our cold brew keeps you cool all summer',
    maxLength: STUDIO_COMPOSITION_LIMITS.briefSummaryMaxLength,
  },
  {
    field: 'audience',
    label: 'Audience',
    placeholder: 'Busy commuters, 25-40',
    maxLength: STUDIO_COMPOSITION_LIMITS.briefFieldMaxLength,
  },
  {
    field: 'callToAction',
    label: 'Call to action',
    placeholder: 'Try it free this week',
    maxLength: STUDIO_COMPOSITION_LIMITS.briefFieldMaxLength,
  },
];

/** Sets a brief field, dropping it when cleared so an empty field is never stored as "". */
const withField = <Key extends keyof StudioCompositionBrief>(
  brief: StudioCompositionBrief,
  key: Key,
  value: StudioCompositionBrief[Key] | ''
): StudioCompositionBrief => {
  const { [key]: _previous, ...rest } = brief;
  return value ? { ...rest, [key]: value } : rest;
};

/** The production's brief: the one-line idea, who it is for, the call to action and the product photo. */
const BriefPanel = ({ composition }: { composition: StudioCompositionResponse }) => {
  const { value: brief, set, status } = useFieldAutosave(composition.id, 'brief', composition.brief);
  const { pick, picker } = useLibraryPicker();

  const pickProductPhoto = () =>
    pick({
      filter: { mode: 'locked', type: 'image' },
      onPicked: ([file]) => file && set(current => withField(current, 'productFileId', file.id)),
    });

  return (
    <StudioPanel testId="production-brief-panel" aria-label="Brief">
      <Stack direction="row" alignItems="center">
        <StudioSectionLabel>Brief</StudioSectionLabel>
        <FieldSaveStatus status={status} testId="production-brief-save-status" />
      </Stack>
      {TEXT_FIELDS.map(({ field, label, placeholder, maxLength }) => (
        <Stack key={field} spacing={0.5}>
          <StudioSectionLabel htmlFor={`production-brief-${field}`}>{label}</StudioSectionLabel>
          <Input
            size="sm"
            id={`production-brief-${field}`}
            placeholder={placeholder}
            value={brief[field] ?? ''}
            onChange={event => set(current => withField(current, field, event.target.value))}
            slotProps={{ input: { maxLength, 'data-testid': `production-brief-${field}-input` } }}
          />
        </Stack>
      ))}
      <Stack spacing={0.5}>
        <StudioSectionLabel>Product photo</StudioSectionLabel>
        <Stack direction="row" spacing={1} alignItems="center">
          {brief.productFileId && (
            <LibraryThumb
              fileId={brief.productFileId}
              testId="production-brief-product-photo"
              onRemove={() => set(current => withField(current, 'productFileId', ''))}
            />
          )}
          <Button size="sm" variant="outlined" onClick={pickProductPhoto} data-testid="production-brief-product-photo-btn">
            {brief.productFileId ? 'Replace' : 'Choose from Library'}
          </Button>
        </Stack>
      </Stack>
      {picker}
    </StudioPanel>
  );
};

export default BriefPanel;

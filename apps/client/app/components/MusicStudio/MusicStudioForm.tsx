import { useMemo } from 'react';
import type { CreateMusicGenerationBody, PublicMusicModel } from '@bike4mind/common';
import GenerationPayerNote from '@client/app/components/Credits/GenerationPayerNote';
import CapabilityForm from '@client/app/components/Studio/CapabilityForm';
import {
  useCapabilityFormState,
  type NonEmptyList,
  type StudioFormRules,
} from '@client/app/components/Studio/useCapabilityFormState';
import { musicModelCards, withRankedMusicDefaultFirst } from './musicCreateV2';
import { musicCapabilityFields } from './musicFields';
import {
  canSubmit,
  clampToModel,
  estimateCredits,
  initialFormFor,
  toCreateBody,
  type MusicFormState,
} from './musicForm';

// Module scope: an inline object would re-run the hook's fallback effect on every render.
const MUSIC_FORM_RULES: StudioFormRules<PublicMusicModel, MusicFormState> = {
  initialFor: initialFormFor,
  clampToModel,
};

type MusicStudioFormProps = {
  models: NonEmptyList<PublicMusicModel>;
  isSubmitting: boolean;
  onSubmit: (body: CreateMusicGenerationBody) => void;
  // Create v2: model cards and a model switch that keeps every value (marking the ones the model rejects).
  createV2?: boolean;
};

const MusicStudioForm = ({ models, isSubmitting, onSubmit, createV2 = false }: MusicStudioFormProps) => {
  // Create v2 opens on the ranker's pick; legacy keeps the server's order.
  const ordered = useMemo(() => (createV2 ? withRankedMusicDefaultFirst(models) : models), [models, createV2]);
  const { form, model, changes, update, selectModel } = useCapabilityFormState(
    ordered,
    MUSIC_FORM_RULES,
    createV2 ? 'keep' : 'clamp'
  );

  if (!model) return null;

  const picker = createV2
    ? { modelCards: musicModelCards(models, form) }
    : { models: models.map(candidate => ({ value: candidate.id, label: candidate.display_name })) };

  return (
    <CapabilityForm
      testIdPrefix="music-form"
      {...picker}
      modelId={form.modelId}
      onModelChange={selectModel}
      changes={changes}
      fields={musicCapabilityFields(model, form, update, createV2 ? 'createV2' : 'legacy')}
      estimateCredits={estimateCredits(form)}
      submitLabel="Generate song"
      canSubmit={canSubmit(form, model)}
      isSubmitting={isSubmitting}
      onSubmit={() => onSubmit(toCreateBody(form, model))}
    >
      <GenerationPayerNote data-testid="music-form-payer-note" />
    </CapabilityForm>
  );
};

export default MusicStudioForm;

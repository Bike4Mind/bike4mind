import type { CreateMusicGenerationBody, PublicMusicModel } from '@bike4mind/common';
import CapabilityForm from '@client/app/components/Studio/CapabilityForm';
import {
  useCapabilityFormState,
  type NonEmptyList,
  type StudioFormRules,
} from '@client/app/components/Studio/useCapabilityFormState';
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
};

const MusicStudioForm = ({ models, isSubmitting, onSubmit }: MusicStudioFormProps) => {
  const { form, model, changes, update, selectModel } = useCapabilityFormState(models, MUSIC_FORM_RULES);

  if (!model) return null;

  return (
    <CapabilityForm
      testIdPrefix="music-form"
      models={models.map(candidate => ({ value: candidate.id, label: candidate.display_name }))}
      modelId={form.modelId}
      onModelChange={selectModel}
      changes={changes}
      fields={musicCapabilityFields(model, form, update)}
      estimateCredits={estimateCredits(form)}
      submitLabel="Generate song"
      canSubmit={canSubmit(form, model)}
      isSubmitting={isSubmitting}
      onSubmit={() => onSubmit(toCreateBody(form, model))}
    />
  );
};

export default MusicStudioForm;

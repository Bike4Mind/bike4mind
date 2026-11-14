import { useMemo } from 'react';
import type { CreateVideoGenerationBody, VideoModel } from '@bike4mind/common';
import ImageBrowserModal from '@client/app/components/Agent/ImageBrowserModal';
import GenerationPayerNote from '@client/app/components/Credits/GenerationPayerNote';
import CapabilityForm from '@client/app/components/Studio/CapabilityForm';
import {
  useCapabilityFormState,
  type NonEmptyList,
  type StudioFormRules,
} from '@client/app/components/Studio/useCapabilityFormState';
import { useImageBrowser } from '@client/app/hooks/agent/useImageBrowser';
import { videoModelCards, withRankedVideoDefaultFirst } from './videoCreateV2';
import { videoCapabilityFields } from './videoFields';
import {
  canSubmit,
  clampToModel,
  estimateCredits,
  initialFormFor,
  toCreateBody,
  type VideoFormState,
} from './videoForm';

// Module scope: an inline object would re-run the hook's fallback effect on every render.
const VIDEO_FORM_RULES: StudioFormRules<VideoModel, VideoFormState> = { initialFor: initialFormFor, clampToModel };

type VideoStudioFormProps = {
  models: NonEmptyList<VideoModel>;
  isSubmitting: boolean;
  onSubmit: (body: CreateVideoGenerationBody) => void;
  // Create v2: model cards, visual controls, and a model switch that keeps every value (marking the ones it rejects).
  createV2?: boolean;
};

const VideoStudioForm = ({ models, isSubmitting, onSubmit, createV2 = false }: VideoStudioFormProps) => {
  // Create v2 opens on the ranker's pick; legacy keeps the server's order.
  const ordered = useMemo(() => (createV2 ? withRankedVideoDefaultFirst(models) : models), [models, createV2]);
  const { form, model, changes, update, selectModel } = useCapabilityFormState(
    ordered,
    VIDEO_FORM_RULES,
    createV2 ? 'keep' : 'clamp'
  );
  const imageBrowser = useImageBrowser();

  if (!model) return null;

  const picker = createV2
    ? { modelCards: videoModelCards(models, form) }
    : { models: models.map(candidate => ({ value: candidate.id, label: candidate.display_name })) };

  return (
    <CapabilityForm
      testIdPrefix="video-form"
      {...picker}
      modelId={form.modelId}
      onModelChange={selectModel}
      changes={changes}
      fields={videoCapabilityFields(
        model,
        form,
        { update, pickImage: () => imageBrowser.openImageBrowser() },
        createV2 ? 'createV2' : 'legacy'
      )}
      estimateCredits={estimateCredits(form)}
      submitLabel="Generate video"
      canSubmit={canSubmit(form)}
      isSubmitting={isSubmitting}
      onSubmit={() => onSubmit(toCreateBody(form, model))}
    >
      <GenerationPayerNote data-testid="video-form-payer-note" />
      <ImageBrowserModal
        isOpen={imageBrowser.isImageBrowserOpen}
        onClose={imageBrowser.closeImageBrowser}
        imageSearch={imageBrowser.imageSearch}
        onImageSearchChange={imageBrowser.setImageSearch}
        isLoadingImages={imageBrowser.isLoadingImages}
        imageFiles={imageBrowser.imageFiles}
        selectedImage={imageBrowser.selectedImage}
        onSelectImage={imageBrowser.selectImage}
        onApplyImage={file => {
          update({ inputImage: { fileId: file.id, fileName: file.fileName } });
          imageBrowser.closeImageBrowser();
        }}
        onSearch={() => void imageBrowser.fetchImageFiles(imageBrowser.imageSearch)}
        title="Choose an image to animate"
        emptyHint="No images yet. Upload one in Files, then choose it here."
      />
    </CapabilityForm>
  );
};

export default VideoStudioForm;

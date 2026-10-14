import type { CreateVideoGenerationBody, VideoModel } from '@bike4mind/common';
import ImageBrowserModal from '@client/app/components/Agent/ImageBrowserModal';
import CapabilityForm from '@client/app/components/Studio/CapabilityForm';
import { useCapabilityFormState, type StudioFormRules } from '@client/app/components/Studio/useCapabilityFormState';
import { useImageBrowser } from '@client/app/hooks/agent/useImageBrowser';
import { videoCapabilityFields } from './videoFields';
import {
  canSubmit,
  clampToModel,
  estimateCredits,
  initialFormFor,
  toCreateBody,
  type VideoFormState,
} from './videoForm';

// Module scope so the form state hook sees a stable reference.
const VIDEO_FORM_RULES: StudioFormRules<VideoModel, VideoFormState> = { initialFor: initialFormFor, clampToModel };

type VideoStudioFormProps = {
  models: VideoModel[];
  isSubmitting: boolean;
  onSubmit: (body: CreateVideoGenerationBody) => void;
};

const VideoStudioForm = ({ models, isSubmitting, onSubmit }: VideoStudioFormProps) => {
  const { form, model, changes, update, selectModel } = useCapabilityFormState(models, VIDEO_FORM_RULES);
  const imageBrowser = useImageBrowser();

  if (!model) return null;

  return (
    <CapabilityForm
      testIdPrefix="video-form"
      models={models.map(candidate => ({ value: candidate.id, label: candidate.display_name }))}
      modelId={form.modelId}
      onModelChange={selectModel}
      changes={changes}
      fields={videoCapabilityFields(model, form, { update, pickImage: () => imageBrowser.openImageBrowser() })}
      estimateCredits={estimateCredits(form)}
      submitLabel="Generate video"
      canSubmit={canSubmit(form)}
      isSubmitting={isSubmitting}
      onSubmit={() => onSubmit(toCreateBody(form))}
    >
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

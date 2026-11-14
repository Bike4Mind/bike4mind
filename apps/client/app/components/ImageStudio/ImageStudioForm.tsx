import { useCallback, useMemo, useState } from 'react';
import { Typography } from '@mui/joy';
import type { ImageModels } from '@bike4mind/common';
import ImageBrowserModal from '@client/app/components/Agent/ImageBrowserModal';
import CapabilityForm from '@client/app/components/Studio/CapabilityForm';
import { useConsumeStudioRestore, type StudioRestore } from '@client/app/components/Studio/restore/studioRestore';
import type { NonEmptyList } from '@client/app/components/Studio/useCapabilityFormState';
import { useImageBrowser } from '@client/app/hooks/agent/useImageBrowser';
import type { CreateStudioImageJobsBody } from '@client/app/hooks/data/studioImageJobs';
import { imageCapabilityFields, type ImageFormState } from './imageFields';
import { restoreImageForm } from './imageRestore';
import {
  EMPTY_IMAGE_INTENT,
  imageCreditsPerImage,
  imageModelCards,
  imageModelWhyNot,
  isCatalogImageModel,
  pickDefaultImageModel,
  type ImageIntent,
} from './imageModelOptions';

type ImageStudioFormProps = {
  // The user's runnable image models, as /api/models lists them.
  models: NonEmptyList<{ id: string; name: string }>;
  isSubmitting: boolean;
  onSubmit: (body: CreateStudioImageJobsBody) => void;
};

const INITIAL_FORM: ImageFormState = { prompt: '', count: 1, intent: EMPTY_IMAGE_INTENT };

const toCreateBody = (model: ImageModels, { prompt, count, intent }: ImageFormState): CreateStudioImageJobsBody => ({
  count,
  request: {
    model,
    mode: 'generate',
    prompt: prompt.trim(),
    ...(intent.size && { size: intent.size }),
    ...(intent.aspectRatio && { aspectRatio: intent.aspectRatio }),
    ...(intent.quality && { quality: intent.quality }),
    ...(intent.references.length > 0 && {
      inputs: intent.references.map(file => ({ role: 'reference' as const, fileId: file.fileId })),
    }),
  },
});

/**
 * Create's image form. The model row shows the ranked pick for the settings, and its panel says for every model
 * whether it can make what they ask for; the default is a visible choice the user can swap, never a hidden auto-pick.
 * Settings persist across a model switch; one the picked model does not take is marked with its reason and a fix, and
 * holds Generate.
 */
const ImageStudioForm = ({ models, isSubmitting, onSubmit }: ImageStudioFormProps) => {
  const [form, setForm] = useState<ImageFormState>(INITIAL_FORM);
  const [pickedModel, setPickedModel] = useState<ImageModels | undefined>();
  // Why a restored take's values did not all come back; cleared by the next model pick, like a switch's notices.
  const [restoreNotices, setRestoreNotices] = useState<string[]>([]);
  const applyRestore = useCallback(
    (restore: StudioRestore) => {
      const restored = restoreImageForm(restore, models);
      setForm(restored.value.form);
      setPickedModel(restored.value.modelId);
      setRestoreNotices(restored.notices);
    },
    [models]
  );
  useConsumeStudioRestore('image', applyRestore);
  const imageBrowser = useImageBrowser();
  const cards = useMemo(() => imageModelCards(models, form.intent), [models, form.intent]);
  // The user's pick stands while its card can be picked; until then, and if a models refetch drops it, the default.
  const model = cards.some(card => card.id === pickedModel && card.unavailableReason === null)
    ? pickedModel
    : pickDefaultImageModel(cards);

  if (model === undefined) {
    return (
      <Typography level="body-sm" data-testid="image-studio-no-generate-model">
        None of your image models can generate from a prompt yet.
      </Typography>
    );
  }

  const update = (patch: Partial<ImageFormState>) => setForm(current => ({ ...current, ...patch }));
  const updateIntent = (patch: Partial<ImageIntent>) =>
    setForm(current => ({ ...current, intent: { ...current.intent, ...patch } }));
  const selectModel = (modelId: string) => {
    const card = cards.find(candidate => candidate.id === modelId);
    if (isCatalogImageModel(modelId) && card?.unavailableReason === null) {
      setPickedModel(modelId);
      setRestoreNotices([]);
    }
  };

  const modelName = cards.find(card => card.id === model)?.name ?? model;
  // Matches the notice the shared form state gives video and music when a models refetch drops the pick.
  const changes = [
    ...restoreNotices,
    ...(pickedModel !== undefined && pickedModel !== model
      ? [`The selected model is no longer available; switched to ${modelName}.`]
      : []),
  ];
  const perImage = imageCreditsPerImage(model, form.intent);
  const canSubmit = form.prompt.trim().length > 0 && imageModelWhyNot(model, form.intent) === null;

  return (
    <CapabilityForm
      testIdPrefix="image-form"
      modelCards={cards}
      modelId={model}
      onModelChange={selectModel}
      changes={changes}
      fields={imageCapabilityFields(model, form, {
        update,
        updateIntent,
        pickReference: () => imageBrowser.openImageBrowser(),
      })}
      estimateCredits={perImage === null ? null : perImage * form.count}
      submitLabel={form.count === 1 ? 'Generate image' : `Generate ${form.count} images`}
      canSubmit={canSubmit}
      isSubmitting={isSubmitting}
      onSubmit={() => onSubmit(toCreateBody(model, form))}
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
          if (!form.intent.references.some(reference => reference.fileId === file.id)) {
            updateIntent({ references: [...form.intent.references, { fileId: file.id, fileName: file.fileName }] });
          }
          imageBrowser.closeImageBrowser();
        }}
        onSearch={() => void imageBrowser.fetchImageFiles(imageBrowser.imageSearch)}
        title="Choose a reference image"
        emptyHint="No images yet. Upload one in Files, then choose it here."
      />
    </CapabilityForm>
  );
};

export default ImageStudioForm;

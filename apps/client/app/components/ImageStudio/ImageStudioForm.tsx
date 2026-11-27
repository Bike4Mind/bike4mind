import { useCallback, useMemo, useState } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import type { ImageInputRole, ImageModels } from '@bike4mind/common';
import ImageBrowserModal from '@client/app/components/Agent/ImageBrowserModal';
import CapabilityForm from '@client/app/components/Studio/CapabilityForm';
import type { ReferenceCutout, ReferenceFile } from '@client/app/components/Studio/capabilityFields';
import { useConsumeStudioRestore, type StudioRestore } from '@client/app/components/Studio/restore/studioRestore';
import type { NonEmptyList } from '@client/app/components/Studio/useCapabilityFormState';
import { useImageBrowser } from '@client/app/hooks/agent/useImageBrowser';
import type { CreateStudioImageJobsBody } from '@client/app/hooks/data/studioImageJobs';
import ImageMaskPainter from './ImageMaskPainter';
import { imageCapabilityFields, type ImageFormState } from './imageFields';
import { referenceFileIdToSend } from './referenceCutouts';
import { useReferenceCutouts } from './useReferenceCutouts';
import { restoreImageForm } from './imageRestore';
import {
  EMPTY_IMAGE_INTENT,
  imageCreditsPerImage,
  imageIntentInputs,
  imageModelCards,
  imageModelWhyNot,
  isCatalogImageModel,
  pickDefaultImageModel,
  type ImageIntent,
} from './imageModelOptions';

type ImageStudioFormProps = {
  // The user's runnable image models, as /api/v1/image-models lists them.
  models: NonEmptyList<{ id: string; name: string }>;
  isSubmitting: boolean;
  onSubmit: (body: CreateStudioImageJobsBody) => void;
};

const INITIAL_FORM: ImageFormState = { prompt: '', count: 1, intent: EMPTY_IMAGE_INTENT };

// A reference whose background was removed is sent as its cutout; the edit source and mask go as they are.
const toCreateBody = (
  model: ImageModels,
  { prompt, count, intent }: ImageFormState,
  cutoutOf: (fileId: string) => ReferenceCutout | undefined
): CreateStudioImageJobsBody => {
  const inputs = imageIntentInputs(intent).map(({ role, file }) => ({
    role,
    fileId: role === 'reference' ? referenceFileIdToSend({ ...file, cutout: cutoutOf(file.fileId) }) : file.fileId,
  }));
  return {
    count,
    request: {
      model,
      mode: intent.mode,
      prompt: prompt.trim(),
      ...(intent.size && { size: intent.size }),
      ...(intent.aspectRatio && { aspectRatio: intent.aspectRatio }),
      ...(intent.quality && { quality: intent.quality }),
      ...(inputs.length > 0 && { inputs }),
    },
  };
};

type PickerRole = Extract<ImageInputRole, 'edit_source' | 'reference'>;

const PICKER_TITLES: Record<PickerRole, string> = {
  edit_source: 'Choose the image to edit',
  reference: 'Choose a reference image',
};

const submitLabelFor = ({ count, intent }: ImageFormState): string => {
  if (intent.mode === 'edit') return count === 1 ? 'Edit image' : `Make ${count} edits`;
  return count === 1 ? 'Make 1 image' : `Make ${count} images`;
};

/**
 * Create's image form. The model row shows the ranked pick for the settings, and its panel says for every model
 * whether it can make what they ask for; the default is a visible choice the user can swap, never a hidden auto-pick.
 * Settings persist across a model switch; one the picked model does not take is marked with its reason and a fix, and
 * holds Generate. Edit mode changes a chosen image (optionally inside a painted mask) instead of making a new one; the
 * cards then rank by what each model can edit.
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
  const [pickerRole, setPickerRole] = useState<PickerRole>('reference');
  const [maskPainterOpen, setMaskPainterOpen] = useState(false);
  const cutouts = useReferenceCutouts();
  const cards = useMemo(() => imageModelCards(models, form.intent), [models, form.intent]);
  // The user's pick stands while its card can be picked; until then, and if a models refetch drops it, the default.
  const model = cards.some(card => card.id === pickedModel && card.unavailableReason === null)
    ? pickedModel
    : pickDefaultImageModel(cards);

  const updateIntent = (patch: Partial<ImageIntent>) =>
    setForm(current => ({ ...current, intent: { ...current.intent, ...patch } }));

  if (model === undefined) {
    if (form.intent.mode === 'edit') {
      return (
        <Stack gap={1} alignItems="flex-start" data-testid="image-studio-no-edit-model">
          <Typography level="body-sm">None of your image models can edit images yet.</Typography>
          <Button
            size="sm"
            variant="outlined"
            onClick={() => updateIntent({ mode: 'generate' })}
            data-testid="image-studio-back-to-create-btn"
          >
            Back to Create
          </Button>
        </Stack>
      );
    }
    const canEdit = pickDefaultImageModel(imageModelCards(models, { ...form.intent, mode: 'edit' })) !== undefined;
    return (
      <Stack gap={1} alignItems="flex-start" data-testid="image-studio-no-generate-model">
        <Typography level="body-sm">None of your image models can generate from a prompt yet.</Typography>
        {canEdit && (
          <Button
            size="sm"
            variant="outlined"
            onClick={() => updateIntent({ mode: 'edit' })}
            data-testid="image-studio-switch-to-edit-btn"
          >
            Edit an image instead
          </Button>
        )}
      </Stack>
    );
  }

  const update = (patch: Partial<ImageFormState>) => setForm(current => ({ ...current, ...patch }));
  const openPicker = (role: PickerRole) => {
    setPickerRole(role);
    imageBrowser.openImageBrowser();
  };
  const applyPicked = (file: ReferenceFile) => {
    if (pickerRole === 'edit_source') {
      // A mask is drawn over one image, so a new source drops it.
      if (form.intent.editSource?.fileId !== file.fileId) updateIntent({ editSource: file, mask: undefined });
    } else if (!form.intent.references.some(reference => reference.fileId === file.fileId)) {
      updateIntent({ references: [...form.intent.references, file] });
    }
    imageBrowser.closeImageBrowser();
  };
  const selectModel = (modelId: string) => {
    const card = cards.find(candidate => candidate.id === modelId);
    if (isCatalogImageModel(modelId) && card?.unavailableReason === null) {
      setPickedModel(modelId);
      setRestoreNotices([]);
    }
  };

  const modelName = cards.find(card => card.id === model)?.name ?? model;
  const pickedCard = cards.find(card => card.id === pickedModel);
  // Matches the notice the shared form state gives video and music when a models refetch drops the pick; a pick that
  // is still listed was set aside by the mode switch instead.
  const switchedNotice =
    pickedCard === undefined
      ? `The selected model is no longer available; switched to ${modelName}.`
      : `${pickedCard.name} cannot ${form.intent.mode === 'edit' ? 'edit images' : 'generate from a prompt'}; using ${modelName}.`;
  const changes = [...restoreNotices, ...(pickedModel !== undefined && pickedModel !== model ? [switchedNotice] : [])];
  const perImage = imageCreditsPerImage(model, form.intent);
  const hasSource = form.intent.mode !== 'edit' || form.intent.editSource !== undefined;
  const canSubmit = form.prompt.trim().length > 0 && hasSource && imageModelWhyNot(model, form.intent) === null;

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
        pickReference: () => openPicker('reference'),
        pickEditSource: () => openPicker('edit_source'),
        drawMask: () => setMaskPainterOpen(true),
        cutoutOf: cutouts.cutoutOf,
        toggleCutout: cutouts.toggleCutout,
      })}
      estimateCredits={perImage === null ? null : perImage * form.count}
      submitLabel={submitLabelFor(form)}
      canSubmit={canSubmit}
      isSubmitting={isSubmitting}
      onSubmit={() => onSubmit(toCreateBody(model, form, cutouts.cutoutOf))}
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
        onApplyImage={file => applyPicked({ fileId: file.id, fileName: file.fileName })}
        onSearch={() => void imageBrowser.fetchImageFiles(imageBrowser.imageSearch)}
        title={PICKER_TITLES[pickerRole]}
        emptyHint="No images yet. Upload one in Files, then choose it here."
      />
      {form.intent.editSource && (
        <ImageMaskPainter
          // Remounted per source, so a stroke layer never outlives the image it was drawn on.
          key={form.intent.editSource.fileId}
          open={maskPainterOpen}
          source={form.intent.editSource}
          onClose={() => setMaskPainterOpen(false)}
          onSaved={mask => {
            updateIntent({ mask });
            setMaskPainterOpen(false);
          }}
        />
      )}
    </CapabilityForm>
  );
};

export default ImageStudioForm;

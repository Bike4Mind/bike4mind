import { useMemo } from 'react';
import StudioModelsGate from '@client/app/components/Studio/StudioModelsGate';
import { useCreateStudioImageJobs, useImageModels } from '@client/app/hooks/data/studioImageJobs';
import ImageStudioForm from './ImageStudioForm';
import { isCatalogImageModel } from './imageModelOptions';

/** Image's Create workspace: the form, once the user has an image model the capability catalog knows. */
const ImageStudioWorkspace = ({ testId }: { testId: string }) => {
  const imageModelList = useImageModels();
  const create = useCreateStudioImageJobs();
  // A model this bundle's catalog does not know (a newer server) cannot be validated here, so it is not offered.
  const imageModels = useMemo(
    () =>
      imageModelList.data
        ?.filter(model => isCatalogImageModel(model.id))
        .map(model => ({ id: model.id, name: model.display_name })),
    [imageModelList.data]
  );

  return (
    <StudioModelsGate testId={testId} noun="image" models={{ isPending: imageModelList.isPending, data: imageModels }}>
      {usable => (
        <ImageStudioForm models={usable} isSubmitting={create.isPending} onSubmit={body => create.mutate(body)} />
      )}
    </StudioModelsGate>
  );
};

export default ImageStudioWorkspace;

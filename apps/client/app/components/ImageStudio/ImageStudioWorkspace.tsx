import { useMemo } from 'react';
import StudioModelsGate from '@client/app/components/Studio/StudioModelsGate';
import { useCreateStudioImageJobs } from '@client/app/hooks/data/studioImageJobs';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import ImageStudioForm from './ImageStudioForm';
import { isCatalogImageModel } from './imageModelOptions';

/** Image's Create workspace: the form, once the user has an image model the capability catalog knows. */
const ImageStudioWorkspace = ({ testId }: { testId: string }) => {
  const modelInfo = useModelInfo();
  const create = useCreateStudioImageJobs();
  const imageModels = useMemo(
    () => modelInfo.data?.filter(model => model.type === 'image' && !model.disabled && isCatalogImageModel(model.id)),
    [modelInfo.data]
  );

  return (
    <StudioModelsGate testId={testId} noun="image" models={{ isPending: modelInfo.isPending, data: imageModels }}>
      {usable => (
        <ImageStudioForm models={usable} isSubmitting={create.isPending} onSubmit={body => create.mutate(body)} />
      )}
    </StudioModelsGate>
  );
};

export default ImageStudioWorkspace;

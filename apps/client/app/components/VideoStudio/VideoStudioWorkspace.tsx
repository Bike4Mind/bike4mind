import StudioModelsGate from '@client/app/components/Studio/StudioModelsGate';
import { useCreateVideoGeneration, useVideoModels } from '@client/app/hooks/data/videoGenerations';
import VideoStudioForm from './VideoStudioForm';

const VideoStudioWorkspace = ({ testId, createV2 = false }: { testId: string; createV2?: boolean }) => {
  const models = useVideoModels();
  const create = useCreateVideoGeneration();

  return (
    <StudioModelsGate testId={testId} noun="video" models={models}>
      {usable => (
        <VideoStudioForm
          models={usable}
          isSubmitting={create.isPending}
          onSubmit={body => create.mutate(body)}
          createV2={createV2}
        />
      )}
    </StudioModelsGate>
  );
};

export default VideoStudioWorkspace;

import StudioModelsGate from '@client/app/components/Studio/StudioModelsGate';
import { useCreateVideoGeneration, useVideoModels } from '@client/app/hooks/data/videoGenerations';
import VideoStudioForm from './VideoStudioForm';

const VideoStudioWorkspace = ({ testId }: { testId: string }) => {
  const models = useVideoModels();
  const create = useCreateVideoGeneration();

  return (
    <StudioModelsGate testId={testId} noun="video" models={models}>
      {usable => (
        <VideoStudioForm models={usable} isSubmitting={create.isPending} onSubmit={body => create.mutate(body)} />
      )}
    </StudioModelsGate>
  );
};

export default VideoStudioWorkspace;

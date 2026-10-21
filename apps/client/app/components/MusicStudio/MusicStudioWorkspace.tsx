import StudioModelsGate from '@client/app/components/Studio/StudioModelsGate';
import { useCreateMusicGeneration, useMusicModels } from '@client/app/hooks/data/musicGenerations';
import MusicStudioForm from './MusicStudioForm';

const MusicStudioWorkspace = ({ testId }: { testId: string }) => {
  const models = useMusicModels();
  const create = useCreateMusicGeneration();

  return (
    <StudioModelsGate testId={testId} noun="music" models={models}>
      {usable => (
        <MusicStudioForm models={usable} isSubmitting={create.isPending} onSubmit={body => create.mutate(body)} />
      )}
    </StudioModelsGate>
  );
};

export default MusicStudioWorkspace;

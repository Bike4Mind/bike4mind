import type { ReactNode } from 'react';
import { CircularProgress, Typography } from '@mui/joy';
import type { NonEmptyList } from './useCapabilityFormState';

type StudioModelsGateProps<TModel> = {
  // `<testId>-loading`, `-error` and `-empty`.
  testId: string;
  // Lower case, as it reads mid-sentence: "video", "music".
  noun: string;
  models: { isPending: boolean; data: TModel[] | undefined };
  children: (models: NonEmptyList<TModel>) => ReactNode;
};

const isNonEmpty = <TModel,>(models: readonly TModel[]): models is NonEmptyList<TModel> => models.length > 0;

/** Renders a modality's form only once it has at least one usable model, and says why when it does not. */
const StudioModelsGate = <TModel,>({ testId, noun, models, children }: StudioModelsGateProps<TModel>) => {
  if (models.isPending) return <CircularProgress size="sm" data-testid={`${testId}-loading`} />;
  // A failed background refetch keeps the last data, so the form stays usable.
  if (!models.data) {
    return (
      <Typography level="body-sm" color="danger" data-testid={`${testId}-error`}>
        Could not load the {noun} models. Refresh to try again.
      </Typography>
    );
  }
  if (!isNonEmpty(models.data)) {
    return (
      <Typography level="body-sm" data-testid={`${testId}-empty`}>
        {noun.charAt(0).toUpperCase() + noun.slice(1)} generation is not available for your account yet.
      </Typography>
    );
  }
  return children(models.data);
};

export default StudioModelsGate;

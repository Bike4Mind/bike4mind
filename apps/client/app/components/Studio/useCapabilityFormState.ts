import { useEffect, useState } from 'react';

export type StudioModel = { id: string; display_name: string };

/**
 * A modality's form rules, kept free of React. The server never rounds a request, so clampToModel is where values
 * are moved onto what a newly selected model supports, and it reports every move for the form to show.
 */
export type StudioFormRules<TModel extends StudioModel, TState extends { modelId: string }> = {
  initialFor: (model: TModel) => TState;
  clampToModel: (state: TState, model: TModel) => { state: TState; changes: string[] };
};

/** Form state shared by every Studio modality: the values, the selected model, and what a model switch changed. */
export function useCapabilityFormState<TModel extends StudioModel, TState extends { modelId: string }>(
  models: readonly TModel[],
  rules: StudioFormRules<TModel, TState>
) {
  const [form, setForm] = useState<TState>(() => rules.initialFor(models[0]));
  const [changes, setChanges] = useState<string[]>([]);
  const model = models.find(candidate => candidate.id === form.modelId);

  // The model list can change under the form (an admin disables a model, a key goes away). Move to a model that is
  // still offered and say so, rather than submit one the server will refuse with model_disabled.
  useEffect(() => {
    if (model || models.length === 0) return;
    const fallback = models[0];
    const clamped = rules.clampToModel(form, fallback);
    setForm(clamped.state);
    setChanges([
      `The selected model is no longer available; switched to ${fallback.display_name}.`,
      ...clamped.changes,
    ]);
  }, [form, model, models, rules]);

  const update = (patch: Partial<TState>) => setForm(previous => ({ ...previous, ...patch }));

  const selectModel = (modelId: string) => {
    const next = models.find(candidate => candidate.id === modelId);
    if (!next || next.id === form.modelId) return;
    const clamped = rules.clampToModel(form, next);
    setForm(clamped.state);
    setChanges(clamped.changes);
  };

  return { form, model, changes, update, selectModel };
}

import { useEffect, useState } from 'react';

export type StudioModel = { id: string; display_name: string };

/** A list known to hold at least one item, so its first element needs no undefined check. */
export type NonEmptyList<T> = readonly [T, ...T[]];

/**
 * A modality's form rules, kept free of React. The server never rounds a request, so clampToModel is where values
 * are moved onto what a newly selected model supports, and it reports every move for the form to show.
 */
export type StudioFormRules<TModel extends StudioModel, TState extends { modelId: string }> = {
  initialFor: (model: TModel) => TState;
  clampToModel: (state: TState, model: TModel) => { state: TState; changes: string[] };
};

/**
 * What picking another model does to the form's values. `clamp` moves them onto the new model and reports each
 * move; `keep` leaves them as they are, for a form that marks the ones the model does not take (Create v2).
 */
export type ModelSwitchPolicy = 'clamp' | 'keep';

/**
 * Form state shared by every Studio modality: the values, the selected model, and what a model switch changed.
 * The model list is a non-empty tuple so the initial state always has a model to describe.
 */
export function useCapabilityFormState<TModel extends StudioModel, TState extends { modelId: string }>(
  models: NonEmptyList<TModel>,
  rules: StudioFormRules<TModel, TState>,
  onModelSwitch: ModelSwitchPolicy = 'clamp'
) {
  const [form, setForm] = useState<TState>(() => rules.initialFor(models[0]));
  const [changes, setChanges] = useState<string[]>([]);
  const model = models.find(candidate => candidate.id === form.modelId);

  // The model list can change under the form (an admin disables a model, a key goes away). Move to a model that is
  // still offered and say so, rather than submit one the server will refuse with model_disabled.
  useEffect(() => {
    if (model) return;
    const fallback = models[0];
    const notice = `The selected model is no longer available; switched to ${fallback.display_name}.`;
    // Under 'keep' the values stay and the field builders mark the ones the fallback does not take.
    const next =
      onModelSwitch === 'keep'
        ? { state: { ...form, modelId: fallback.id }, changes: [] }
        : rules.clampToModel(form, fallback);
    setForm(next.state);
    setChanges([notice, ...next.changes]);
  }, [form, model, models, rules, onModelSwitch]);

  const update = (patch: Partial<TState>) => setForm(previous => ({ ...previous, ...patch }));

  const selectModel = (modelId: string) => {
    const next = models.find(candidate => candidate.id === modelId);
    if (!next || next.id === form.modelId) return;
    if (onModelSwitch === 'keep') {
      setForm(previous => ({ ...previous, modelId: next.id }));
      setChanges([]);
      return;
    }
    const clamped = rules.clampToModel(form, next);
    setForm(clamped.state);
    setChanges(clamped.changes);
  };

  return { form, model, changes, update, selectModel };
}

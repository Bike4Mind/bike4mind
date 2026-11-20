// The admin editor's working copy of one module's live edits: one unit per place, keyed as the server keys
// them. An edit that puts a field back to the repo text drops its unit, so the saved set only holds changes.
import { unitKey, type AnchorUnit, type CopyField, type OverrideUnit, type TutorialStep } from '@bike4mind/common';

export type OverrideDraft = Readonly<Record<string, OverrideUnit>>;

export interface RepoTurn {
  turn: number;
  prompt: string;
  reply: string;
}

export const draftFrom = (fields: readonly OverrideUnit[]): OverrideDraft =>
  Object.fromEntries(fields.map(unit => [unitKey(unit), unit]));

export const unitsOf = (draft: OverrideDraft): OverrideUnit[] => Object.values(draft);

function put(draft: OverrideDraft, key: string, unit: OverrideUnit | null): OverrideDraft {
  const next = { ...draft };
  if (unit) next[key] = unit;
  else delete next[key];
  return next;
}

export function copyValue(draft: OverrideDraft, step: TutorialStep, field: CopyField): string {
  const unit = draft[`copy:${step.id}:${field}`];
  return unit?.kind === 'copy' ? unit.value : (step[field] ?? '');
}

export function setCopy(draft: OverrideDraft, step: TutorialStep, field: CopyField, value: string): OverrideDraft {
  const repoValue = step[field] ?? '';
  const unit: OverrideUnit | null =
    value === repoValue ? null : { kind: 'copy', stepId: step.id, field, value, repoValue };
  return put(draft, `copy:${step.id}:${field}`, unit);
}

export const anchorOf = (step: TutorialStep): AnchorUnit => ({
  ...(step.anchor !== undefined && { anchor: step.anchor }),
  ...(step.anchorScope !== undefined && { anchorScope: step.anchorScope }),
  ...(step.placement !== undefined && { placement: step.placement }),
  ...(step.avoid !== undefined && { avoid: step.avoid }),
});

const sameAnchor = (a: AnchorUnit, b: AnchorUnit) =>
  a.anchor === b.anchor && a.anchorScope === b.anchorScope && a.placement === b.placement && a.avoid === b.avoid;

export function anchorValue(draft: OverrideDraft, step: TutorialStep): AnchorUnit {
  const unit = draft[`anchor:${step.id}`];
  return unit?.kind === 'anchor' ? unit.value : anchorOf(step);
}

export function setAnchor(draft: OverrideDraft, step: TutorialStep, value: AnchorUnit): OverrideDraft {
  const repoValue = anchorOf(step);
  const clean = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== '')) as AnchorUnit;
  const unit: OverrideUnit | null = sameAnchor(clean, repoValue)
    ? null
    : { kind: 'anchor', stepId: step.id, value: clean, repoValue };
  return put(draft, `anchor:${step.id}`, unit);
}

export function turnValue(draft: OverrideDraft, turn: RepoTurn): { prompt: string; reply: string } {
  const unit = draft[`turn:${turn.turn}`];
  if (unit?.kind === 'prompt') return unit.value;
  if (unit?.kind === 'reply') return { prompt: turn.prompt, reply: unit.value };
  return { prompt: turn.prompt, reply: turn.reply };
}

/** A changed prompt always travels with its reply; a reply changed alone moves no learner. */
export function setTurn(draft: OverrideDraft, turn: RepoTurn, value: { prompt: string; reply: string }): OverrideDraft {
  const repoValue = { prompt: turn.prompt, reply: turn.reply };
  let unit: OverrideUnit | null = null;
  if (value.prompt !== turn.prompt) unit = { kind: 'prompt', turn: turn.turn, value, repoValue };
  else if (value.reply !== turn.reply)
    unit = { kind: 'reply', turn: turn.turn, value: value.reply, repoValue: turn.reply };
  return put(draft, `turn:${turn.turn}`, unit);
}

/** The order shown: the draft's, while it still names exactly the repo's steps; otherwise the repo's. */
export function orderOf(draft: OverrideDraft, repoIds: readonly string[]): string[] {
  const unit = draft.order;
  if (unit?.kind !== 'order') return [...repoIds];
  const sameSet = unit.value.length === repoIds.length && repoIds.every(id => unit.value.includes(id));
  return sameSet ? [...unit.value] : [...repoIds];
}

export function moveStep(draft: OverrideDraft, repoIds: readonly string[], stepId: string, by: -1 | 1): OverrideDraft {
  const order = orderOf(draft, repoIds);
  const from = order.indexOf(stepId);
  const to = from + by;
  if (from < 0 || to < 0 || to >= order.length) return draft;
  [order[from], order[to]] = [order[to], order[from]];
  const unchanged = order.every((id, i) => id === repoIds[i]);
  return put(draft, 'order', unchanged ? null : { kind: 'order', value: order, repoValue: [...repoIds] });
}

/** Drops every edit on one step: its copy, its anchor and the turn it sends. Order is the module's, so it stays. */
export function resetStep(draft: OverrideDraft, step: TutorialStep): OverrideDraft {
  return Object.fromEntries(
    Object.entries(draft).filter(
      ([key]) =>
        !key.startsWith(`copy:${step.id}:`) &&
        key !== `anchor:${step.id}` &&
        !(step.turn !== undefined && key === `turn:${step.turn}`)
    )
  );
}

const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

/** One line per edit, repo text first, for the diff the admin reads before saving. */
export function diffOf(draft: OverrideDraft): { key: string; before: string; after: string }[] {
  return unitsOf(draft)
    .map(unit => ({ key: unitKey(unit), before: show(unit.repoValue), after: show(unit.value) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export const sameDraft = (a: OverrideDraft, b: OverrideDraft) =>
  JSON.stringify(diffOf(a)) === JSON.stringify(diffOf(b));

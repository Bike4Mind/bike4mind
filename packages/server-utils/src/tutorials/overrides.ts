// An admin's live edits to a repo tutorial module, as units each remembering the repo value it was written
// over. A deploy that changes that repo value retires the unit (the repo caught up) or leaves it stale for
// review; it is never applied over text it was not written against. Pure: the server applies these per request.
import { createHash } from 'node:crypto';
import {
  STRUCTURAL_KINDS,
  unitKey,
  type AnchorUnit,
  type OverrideUnit,
  type TutorialStep,
  type UnitState,
} from '@bike4mind/common';
import type { TutorialTurn } from './types';

export {
  COPY_FIELDS,
  OverrideUnitSchema,
  OverrideUnitsSchema,
  STRUCTURAL_KINDS,
  unitKey,
  type AnchorUnit,
  type CopyField,
  type OverrideUnit,
  type UnitState,
} from '@bike4mind/common';

/** Module id to step id to field names. */
export type FieldMap = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

export interface OverridePolicy {
  /** The copy fields each step writes as a plain literal (the generated `editableFields.json`). */
  editable: FieldMap;
  /** Fields held to exact repo text, which an editor shows read-only. */
  pinned?: FieldMap;
}

/**
 * Why a unit may not be written at all, or null when it may. Copy and prompts are editable only where the
 * repo writes them as a plain literal, so text derived in code stays code's; turn 0's prompt also feeds
 * whatever the owner builds from it.
 */
export function lockedReason(
  moduleId: string,
  unit: OverrideUnit,
  steps: readonly TutorialStep[],
  policy: OverridePolicy
): string | null {
  if (unit.kind === 'copy') {
    if (policy.pinned?.[moduleId]?.[unit.stepId]?.includes(unit.field)) return `${unit.field} is pinned in code`;
    if (!policy.editable[moduleId]?.[unit.stepId]?.includes(unit.field)) return `${unit.field} is derived in code`;
  }
  if (unit.kind === 'prompt') {
    const step = steps.find(s => s.turn === unit.turn);
    if (!step || !policy.editable[moduleId]?.[step.id]?.includes('prompt'))
      return `turn ${unit.turn}'s prompt is derived in code`;
  }
  return null;
}

/** Per step id, the copy fields an edit may change; prompts appear under the step that sends them. */
export function editableOf(moduleId: string, policy: OverridePolicy): Record<string, string[]> {
  const pinned = policy.pinned?.[moduleId] ?? {};
  return Object.fromEntries(
    Object.entries(policy.editable[moduleId] ?? {}).map(([stepId, fields]) => [
      stepId,
      fields.filter(f => !pinned[stepId]?.includes(f)),
    ])
  );
}

const anchorOf = (step: TutorialStep): AnchorUnit => ({
  ...(step.anchor !== undefined && { anchor: step.anchor }),
  ...(step.anchorScope !== undefined && { anchorScope: step.anchorScope }),
  ...(step.placement !== undefined && { placement: step.placement }),
  ...(step.avoid !== undefined && { avoid: step.avoid }),
});

const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sorted(v)])
    );
  }
  return value;
}

/** What the repo says today at the place a unit edits; undefined when that place is gone. */
export function currentRepoValue(
  unit: OverrideUnit,
  steps: readonly TutorialStep[],
  transcript: readonly TutorialTurn[]
): unknown {
  const step = 'stepId' in unit ? steps.find(s => s.id === unit.stepId) : undefined;
  switch (unit.kind) {
    case 'copy':
      return step?.[unit.field];
    case 'anchor':
      return step && anchorOf(step);
    case 'order':
      return steps.map(s => s.id);
    case 'prompt': {
      const t = transcript[unit.turn];
      return t && { prompt: t.prompt, reply: t.reply };
    }
    case 'reply':
      return transcript[unit.turn]?.reply;
  }
}

export function unitState(
  unit: OverrideUnit,
  steps: readonly TutorialStep[],
  transcript: readonly TutorialTurn[]
): UnitState {
  const now = currentRepoValue(unit, steps, transcript);
  if (now === undefined) return 'stale';
  if (unit.kind === 'order' && !samePermutation(unit.value, now as string[])) return 'stale';
  if (same(now, unit.value)) return 'retired';
  return same(now, unit.repoValue) ? 'live' : 'stale';
}

const samePermutation = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set(a).size === a.length && b.every(id => a.includes(id));

export interface AppliedOverrides {
  steps: TutorialStep[];
  transcript: TutorialTurn[];
  states: { key: string; state: UnitState }[];
  /** Hash of the structural values actually applied; a change moves the module's revision. */
  structuralDigest: string;
}

/** Applies the live units to the repo's steps and transcript. Inputs are not mutated. */
export function applyOverrides(
  units: readonly OverrideUnit[],
  repoSteps: readonly TutorialStep[],
  repoTranscript: readonly TutorialTurn[]
): AppliedOverrides {
  const states = units.map(unit => ({ unit, state: unitState(unit, repoSteps, repoTranscript) }));
  const live = states.filter(s => s.state === 'live').map(s => s.unit);

  let steps = repoSteps.map(s => ({ ...s }));
  const transcript = repoTranscript.map(t => ({ ...t }));
  const stepById = (id: string) => steps.find(s => s.id === id);

  for (const unit of live) {
    if (unit.kind === 'copy') stepById(unit.stepId)![unit.field] = unit.value;
    if (unit.kind === 'anchor') {
      const step = stepById(unit.stepId)!;
      delete step.anchor;
      delete step.anchorScope;
      delete step.placement;
      delete step.avoid;
      Object.assign(step, unit.value);
    }
    if (unit.kind === 'reply') transcript[unit.turn].reply = unit.value;
    if (unit.kind === 'prompt') {
      transcript[unit.turn] = { ...transcript[unit.turn], ...unit.value };
      for (const step of steps) if (step.turn === unit.turn) step.prompt = unit.value.prompt;
    }
  }
  const order = live.find(u => u.kind === 'order');
  if (order) steps = order.value.map(id => stepById(id)!);

  return {
    steps,
    transcript,
    states: states.map(({ unit, state }) => ({ key: unitKey(unit), state })),
    structuralDigest: structuralDigestOf(live),
  };
}

export function structuralDigestOf(liveUnits: readonly OverrideUnit[]): string {
  const structural = liveUnits
    .filter(u => STRUCTURAL_KINDS.has(u.kind))
    .map(u => [unitKey(u), sorted(u.value)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(structural)).digest('hex').slice(0, 32);
}

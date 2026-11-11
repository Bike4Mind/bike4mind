// The shape of an admin's live tutorial edit, shared by the server that applies it and the admin editor that
// writes it. Holds no module content, so the page may import it.
import { z } from 'zod';
import { TUTORIAL_CARD_SIDES } from './tutorial';

export const COPY_FIELDS = ['title', 'body', 'doneBody'] as const;
export type CopyField = (typeof COPY_FIELDS)[number];

const TEXT_MAX = 4000;
const text = z.string().max(TEXT_MAX);

const AnchorUnitSchema = z.object({
  anchor: z.string().max(200).optional(),
  anchorScope: z.string().max(200).optional(),
  placement: z.enum(TUTORIAL_CARD_SIDES).optional(),
  avoid: z.string().max(400).optional(),
});
export type AnchorUnit = z.infer<typeof AnchorUnitSchema>;

const stepId = z.string().min(1).max(80);
const turn = z.number().int().min(1).max(200);
// Turn 0's prompt feeds the finale headline and the sample link, so only its reply is open to an edit.
const replyTurn = z.number().int().min(0).max(200);

export const OverrideUnitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('copy'), stepId, field: z.enum(COPY_FIELDS), value: text, repoValue: text }),
  z.object({ kind: z.literal('anchor'), stepId, value: AnchorUnitSchema, repoValue: AnchorUnitSchema }),
  z.object({
    kind: z.literal('order'),
    value: z.array(stepId).min(1).max(200),
    repoValue: z.array(stepId).min(1).max(200),
  }),
  z.object({
    kind: z.literal('prompt'),
    turn,
    value: z.object({ prompt: text, reply: text }),
    repoValue: z.object({ prompt: text, reply: text }),
  }),
  z.object({ kind: z.literal('reply'), turn: replyTurn, value: text, repoValue: text }),
]);
export type OverrideUnit = z.infer<typeof OverrideUnitSchema>;
export const OverrideUnitsSchema = z.array(OverrideUnitSchema).max(400);

/** Order, anchors and prompts decide where a saved walk stands, so changing one restarts it. */
export const STRUCTURAL_KINDS: ReadonlySet<OverrideUnit['kind']> = new Set(['order', 'anchor', 'prompt']);

/** live: applied. retired: the repo now says the same. stale: the repo moved under it, so it waits for review. */
export type UnitState = 'live' | 'retired' | 'stale';

/** One key per thing a unit edits, so two units can never fight over the same text. */
export function unitKey(unit: OverrideUnit): string {
  switch (unit.kind) {
    case 'copy':
      return `copy:${unit.stepId}:${unit.field}`;
    case 'anchor':
      return `anchor:${unit.stepId}`;
    case 'order':
      return 'order';
    case 'prompt':
    case 'reply':
      return `turn:${unit.turn}`;
  }
}

/** The file the admin editor's Export downloads and `scripts/apply-tutorial-override.mjs` writes into the repo. */
export const OVERRIDE_BUNDLE_FORMAT = 'tutorial-overrides/1';
/** A made tutorial exported whole, which the same script writes as a new module directory. */
export const MODULE_BUNDLE_FORMAT = 'tutorial-module/1';
export const OverrideBundleSchema = z.object({
  format: z.literal(OVERRIDE_BUNDLE_FORMAT),
  moduleId: z.string(),
  version: z.number().int().min(1),
  revision: z.number().int().min(0),
  exportedAt: z.string(),
  units: OverrideUnitsSchema.min(1),
  changes: z.array(z.object({ author: z.string(), reason: z.string(), at: z.string() })),
});
export type OverrideBundle = z.infer<typeof OverrideBundleSchema>;

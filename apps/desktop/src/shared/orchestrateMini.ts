import { z } from 'zod';
import { viewSnapshotSchema } from './viewSnapshot';

/*
 * What the Orchestrate stage hands the always-on-top mini window (main/orchestrateMini): the same
 * ViewSnapshot the stage's views draw from, already redacted when Presenter mode is on, plus the active
 * skin's resolved colours. It crosses two process boundaries (stage -> main -> mini window) and is parsed
 * with this schema on each receipt, so neither main nor the mini window trusts the shape it was sent.
 */

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** A resolved font stack (statePalette.ts FONT_STACKS): letters, spaces, commas, hyphens and quotes only. */
const fontStack = z
  .string()
  .max(120)
  .regex(/^[A-Za-z0-9 ,"-]+$/);

/**
 * The parts of the stage's SkinTheme a compact list can show. No `needs-you` key, by construction: that
 * colour is never skinnable (statePalette.ts).
 */
const miniSkinSchema = z.strictObject({
  id: z.string().min(1).max(200).nullable(),
  states: z.strictObject({
    working: hexColor.optional(),
    done: hexColor.optional(),
    failed: hexColor.optional(),
    stopped: hexColor.optional(),
    idle: hexColor.optional(),
  }),
  surfaces: z.strictObject({ stage: hexColor.optional(), card: hexColor.optional() }),
  fontFamily: fontStack.optional(),
});

export const orchestrateMiniPayloadSchema = z.strictObject({
  snapshot: viewSnapshotSchema,
  /** Presenter mode is on, so `snapshot` is the redacted one; the mini window says so. */
  presenting: z.boolean(),
  skin: miniSkinSchema,
});

export type OrchestrateMiniSkin = z.infer<typeof miniSkinSchema>;
export type OrchestrateMiniPayload = z.infer<typeof orchestrateMiniPayloadSchema>;

/**
 * What a receiver makes of a pushed value: a payload, `null` for "no orchestration on stage", or
 * `undefined` for anything malformed, which the receiver drops rather than draws.
 */
export function parseOrchestrateMiniPayload(value: unknown): OrchestrateMiniPayload | null | undefined {
  if (value === null) return null;
  const parsed = orchestrateMiniPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

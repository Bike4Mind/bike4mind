/**
 * Per-actor color identity, shared by every surface that renders the log (the
 * SPA channel view and roster, the CLI /hearth command) so one actor reads as
 * the same identity everywhere.
 *
 * WHY ONLY FOUR HUES. A log is an all-pairs problem: any two actors can post
 * back to back, so every pair of colors has to be separable, not just the pairs
 * that happen to be adjacent in the palette order. Four is the largest subset of
 * the house categorical palette that clears the all-pairs gates in BOTH theme
 * modes - worst pair, light: CVD dE 13.0, normal-vision dE 19.6; dark: CVD dE
 * 6.9, normal-vision dE 19.3 (OKLab x100). Adding a fifth drops a pair below the
 * normal-vision floor of 15, i.e. below what full-color vision can separate.
 * These hexes are palette steps, not free choices: re-pick one and the set has
 * to be re-validated as a set.
 *
 * WHY A HASH, AND WHAT IT COSTS. The slot is a pure function of actorId, so a
 * session keeps its color across reloads and across surfaces, and an actor
 * joining or leaving never repaints anyone else - the failure the alternatives
 * (index in the rendered array, rank in the roster, arrival order) all have, and
 * a color that moves is worse than no color at all. The cost is that with more
 * than four actors two of them share a hue. That is acceptable ONLY because
 * color is never the identity here: the actor name and the actor-kind badge are
 * always rendered beside it and carry the meaning on their own. Do not add a
 * fifth hue to dodge the collisions.
 *
 * Light-mode yellow and magenta sit below 3:1 against the surface, so callers
 * must keep the actor name in normal text ink and let a mark carry the hue -
 * never color the name itself.
 */
export interface ActorColor {
  light: string;
  dark: string;
}

export const ACTOR_COLOR_SLOTS: ReadonlyArray<ActorColor> = [
  { light: '#2a78d6', dark: '#3987e5' }, // blue
  { light: '#eda100', dark: '#c98500' }, // yellow
  { light: '#e87ba4', dark: '#d55181' }, // magenta
  { light: '#008300', dark: '#008300' }, // green
];

/** For a row with no usable actorId. Never a generated hue. */
export const NEUTRAL_ACTOR_COLOR: ActorColor = { light: '#898781', dark: '#898781' };

/**
 * djb2 over the actorId, folded into the slot list. Exported so the surfaces'
 * tests can pin determinism: the same actorId must always map to the same slot.
 */
export function actorColorSlot(actorId: string): number {
  let hash = 5381;
  for (let i = 0; i < actorId.length; i++) {
    hash = ((hash << 5) + hash + actorId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % ACTOR_COLOR_SLOTS.length;
}

export function actorColor(actorId: string): ActorColor {
  return actorId ? ACTOR_COLOR_SLOTS[actorColorSlot(actorId)] : NEUTRAL_ACTOR_COLOR;
}

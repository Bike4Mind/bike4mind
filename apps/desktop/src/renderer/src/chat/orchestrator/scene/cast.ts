import { byAge, hashOf, type Epithet } from '@shared/agentPersona';

export type CastSubject = { id: string; createdAt: string; epithet?: Epithet };

/** A sprite and the hue its sheet tints it by. */
export type SceneArt = { src: string; hue?: number };

export const hueFilter = (art: SceneArt | undefined): string | undefined =>
  art?.hue ? `hue-rotate(${art.hue}deg)` : undefined;

/**
 * Gives every agent a sheet index (0-based) into a scene's cast, a pure function of the roster so it survives
 * reloads. Oldest first, each agent takes a sheet nobody has yet, preferring one whose craft matches its
 * epithet and otherwise walking the cast from a point picked by its id hash. Only once every sheet is in
 * use does one repeat, and then a fresh round starts so repeats spread evenly.
 */
export function assignSheets(
  agents: readonly CastSubject[],
  crafts: readonly (Epithet | undefined)[]
): Map<string, number> {
  const count = crafts.length;
  if (count === 0) throw new Error('assignSheets: empty cast');
  const taken = new Set<number>();
  const sheets = new Map<string, number>();
  for (const agent of [...agents].sort(byAge)) {
    if (taken.size >= count) taken.clear();
    const start = hashOf(agent.id) % count;
    let first: number | undefined;
    let match: number | undefined;
    for (let step = 0; step < count && match === undefined; step++) {
      const sheet = (start + step) % count;
      if (taken.has(sheet)) continue;
      first ??= sheet;
      if (agent.epithet && crafts[sheet] === agent.epithet) match = sheet;
    }
    const sheet = match ?? first ?? 0;
    taken.add(sheet);
    sheets.set(agent.id, sheet);
  }
  return sheets;
}

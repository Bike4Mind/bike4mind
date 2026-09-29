import type { SkillSummary } from '@shared/skills';

/**
 * When the composer is asking for a skill, and which ones answer.
 *
 * Separated from the component because this is where the feature is easy to get subtly wrong -
 * a slash mid-sentence opening a menu, or a ranking that buries the exact name the user typed -
 * and those are questions a test can settle without a DOM.
 */

/**
 * The filter text while the composer is composing a skill name, or null when it is not.
 *
 * ONE leading slash and no whitespace after it. `/rev` is asking; `fix /rev` is a sentence with a
 * slash in it, `/review src/x.ts` is a skill whose arguments are being typed (the menu has done
 * its job and closed), and `//` is not a name. A menu that opened for any of those would be a
 * menu the user has to dismiss to carry on typing.
 */
export function skillQuery(text: string): string | null {
  const match = /^\/([A-Za-z0-9_:-]*)$/.exec(text);
  return match ? match[1] : null;
}

/**
 * Skills matching `query`, best first.
 *
 * Descriptions are a FALLBACK, not a peer of the name: they are long, and a skill description
 * says things like "use when the user says ..." - so on a two-letter query nearly every skill
 * contains the substring somewhere, and a filter that returns 29 of 31 rows has stopped
 * filtering. Names are matched first; descriptions are searched only when no name matched at
 * all, which is the case the fallback exists for (the user remembers what a skill does but not
 * what it is called).
 *
 * Project skills lead within each tier. They are the ones that arrived with the repository, so
 * they are both the most likely to be wanted in a Code session and the ones worth putting where
 * the user will read their label rather than a name they assume is their own.
 */
export function matchSkills(skills: readonly SkillSummary[], query: string): SkillSummary[] {
  const needle = query.trim().toLowerCase();
  const byName = rankAll(skills, skill => nameRank(skill.name.toLowerCase(), needle));
  if (byName.length > 0 || !needle) return byName;
  return rankAll(skills, skill => (skill.description.toLowerCase().includes(needle) ? 0 : -1));
}

function rankAll(skills: readonly SkillSummary[], rank: (skill: SkillSummary) => number): SkillSummary[] {
  return skills
    .map(skill => ({ skill, rank: rank(skill) }))
    .filter(entry => entry.rank >= 0)
    .sort(
      (a, b) =>
        a.rank - b.rank || sourceOrder(a.skill) - sourceOrder(b.skill) || a.skill.name.localeCompare(b.skill.name)
    )
    .map(entry => entry.skill);
}

function sourceOrder(skill: SkillSummary): number {
  return skill.source === 'project' ? 0 : 1;
}

/** Lower is better; -1 means no match. */
function nameRank(name: string, needle: string): number {
  if (!needle) return 0;
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  return name.includes(needle) ? 2 : -1;
}

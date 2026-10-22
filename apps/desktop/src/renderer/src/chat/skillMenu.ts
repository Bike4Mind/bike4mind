import { findSkillMentions, type SkillMention, type SkillSource, type SkillSummary } from '@shared/skills';

/**
 * When the composer is asking for a skill, and which ones answer.
 *
 * Separated from the component because this is where the feature is easy to get subtly wrong -
 * a slash mid-sentence opening a menu, or a ranking that buries the exact name the user typed -
 * and those are questions a test can settle without a DOM.
 */

/** The `/token` the caret is in, while a skill name is being composed. */
export interface SlashQuery {
  /** The name typed so far, without the slash. Empty right after the slash. */
  query: string;
  /** Index of the slash. */
  start: number;
  /** The caret: where the typed name ends and a picked one stops replacing. */
  end: number;
  /**
   * The token is the whole draft. Commands are offered only then: one runs instead of sending,
   * so a command picked out of the middle of a sentence would throw the sentence away.
   */
  wholeDraft: boolean;
}

/**
 * The token the caret is composing, or null when it is not composing one.
 *
 * A slash at the start of the draft OR after whitespace, name characters up to the caret, and
 * nothing glued on after it. `fix /rev|` and `/rev|` are asking; `src/ma|in` and `and/or` are a
 * path and a word, `/review src/x.ts|` is arguments being typed (the menu has done its job), and
 * `//` is not a name. A menu that opened for any of those would be a menu the user has to dismiss
 * to carry on typing.
 */
export function skillQuery(text: string, caret: number = text.length): SlashQuery | null {
  const after = text.charAt(caret);
  if (after && !/\s/.test(after)) return null;
  const match = /(^|\s)\/([A-Za-z0-9_:-]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const start = match.index + match[1].length;
  return { query: match[2], start, end: caret, wholeDraft: start === 0 && !text.slice(caret).trim() };
}

/**
 * The draft with `name` put in place of the token being composed, and where the caret goes.
 *
 * A space follows the name so the user is positioned to type arguments - and that space is also
 * what closes the menu. One already there is reused rather than doubled.
 */
export function insertSkill(text: string, token: SlashQuery, name: string): { text: string; caret: number } {
  const rest = text.slice(token.end);
  const head = `${text.slice(0, token.start)}/${name}`;
  return { text: head + (rest.startsWith(' ') ? rest : ` ${rest}`), caret: head.length + 1 };
}

/**
 * The tokens in `text` worth drawing as skills: a known skill anywhere, or a command when it
 * leads the draft (the only place a command runs). Unknown names stay plain text, since they
 * are sent as typed.
 */
export function highlightedTokens(
  text: string,
  skillNames: ReadonlySet<string>,
  isCommand: (name: string) => boolean
): SkillMention[] {
  const tokens = findSkillMentions(text).filter(
    mention => skillNames.has(mention.name) || (mention.start === 0 && isCommand(mention.name))
  );
  const first = tokens[0];
  // A leading invocation takes the rest of the draft as arguments, so later names do not run.
  if (first && first.start === 0 && skillNames.has(first.name) && /^\s*$|^\s/.test(text.slice(first.end))) {
    return [first];
  }
  return tokens;
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
export function matchSkills(skills: readonly SkillSummary[], query: string, namesOnly = false): SkillSummary[] {
  const needle = query.trim().toLowerCase();
  const byName = rankAll(skills, skill => nameRank(skill.name.toLowerCase(), needle));
  if (byName.length > 0 || !needle || namesOnly) return byName;
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
  return { project: 0, global: 1, account: 2 }[skill.source];
}

/** Chip colour per source, shared by the picker, the thread and Customize. */
export function skillChipColor(source: SkillSource): 'warning' | 'primary' | 'neutral' {
  if (source === 'project') return 'warning';
  return source === 'account' ? 'primary' : 'neutral';
}

export function skillSourceLabel(source: SkillSource): string {
  if (source === 'project') return 'Project';
  return source === 'account' ? 'Bike4Mind' : 'Global';
}

/** Lower is better; -1 means no match. */
function nameRank(name: string, needle: string): number {
  if (!needle) return 0;
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  return name.includes(needle) ? 2 : -1;
}

import { buildSkillsPromptSection, type CustomCommand } from '@bike4mind/cli/skills';
import type { SkillCatalog } from './SkillCatalog';

/**
 * The list of skills the model is shown, as system-prompt text.
 *
 * Without it the `skill` tool is unreachable in practice: a model that cannot see the names has
 * nothing to pass, and the observed failure this exists to fix was a session asked "can you run
 * skills?" searching the repository for an answer. The DESCRIPTIONS are the working part - they
 * are written as trigger conditions ("Use whenever the user asks ...") and are the whole
 * mechanism by which the right skill gets picked - so they are carried up to the spec's length
 * and the bodies are not carried at all.
 *
 * The formatting is the CLI's, imported rather than re-derived, for the same reason expand.ts
 * imports the argument grammar: the entry format and the "prefer a skill over doing it by hand"
 * wording should have one definition. Its worked example reads `skill({ skill: "commit" })`,
 * which is why the desktop's tool takes the same name and the same argument.
 */

/**
 * Bytes of skill list that may reach the system prompt before descriptions give way to names.
 *
 * It is re-sent on every round of every turn and sits inside the cached prefix, so it is capped
 * for the same reason MAX_INSTRUCTIONS_BYTES is - a separate allowance rather than a share of
 * that one, because the two grow for unrelated reasons and a long CLAUDE.md should not silently
 * cost the user their skill list. Sized so a typical 40-60 skill setup is listed whole: measured
 * real entries run 400-600 bytes, so this holds 50-75 of them (about 8k tokens, read from the
 * prompt cache after the first round). Past it, skills are still listed, by name only.
 */
export const MAX_SKILLS_PROMPT_BYTES = 32_000;

/**
 * The longest one description may be, in characters: the Agent Skills spec's own maximum for the
 * frontmatter field. It keeps one skill with an essay in its frontmatter from spending the
 * allowance above that a dozen others needed.
 */
export const MAX_DESCRIPTION_CHARS = 1_024;

/**
 * `commands` rendered to a bounded section, or '' when there is nothing to list.
 *
 * Every model-invocable skill is named. Project skills come first, then the user's own, each
 * group sorted by name so the bytes depend on the set of skills and never on scan order - the
 * section sits in the cached prefix. When the full entries overrun `limit`, the ones at the end
 * are reduced to a names-only line rather than dropped: an entry is cut whole, because half a
 * trigger condition reads as a complete one, but a name the model never sees is a skill it never
 * runs.
 */
export function buildSkillsSection(commands: readonly CustomCommand[], limit = MAX_SKILLS_PROMPT_BYTES): string {
  const listed = commands
    // An import's description is a stranger's text, and this section is the trusted system
    // prompt. The skill tool still runs an import by name.
    .filter(command => !command.untrusted && !command.disableModelInvocation)
    .map(forPrompt)
    .sort(byGroupThenName);
  if (listed.length === 0) return '';

  const full = buildSkillsPromptSection(listed);
  if (listed.length === 1 || Buffer.byteLength(full) <= limit) return full;

  // The size only grows with the number of full entries (an entry is always longer than its name
  // in the list), so the largest prefix that fits is found by bisection. One full entry is kept
  // whatever the limit, since the CLI formatter's header and guidance come with its first entry.
  const sizeWith = (kept: number) => Buffer.byteLength(withNamesOnly(listed, kept));
  let low = 1;
  let high = listed.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (sizeWith(mid) <= limit) low = mid;
    else high = mid - 1;
  }
  return withNamesOnly(listed, low);
}

/**
 * The first `kept` skills in full and the rest by name. Names are never cut, so a user with
 * hundreds of skills can exceed the limit by their names alone; that is the price of every skill
 * being reachable.
 */
function withNamesOnly(listed: readonly CustomCommand[], kept: number): string {
  const names = listed.slice(kept).map(command => command.name);
  return (
    `${buildSkillsPromptSection(listed.slice(0, kept))}\n` +
    `Also available: ${names.join(', ')}.\n` +
    `Their descriptions are left out for space; the skill tool runs any of them by name.\n`
  );
}

/**
 * The entry the formatter is given. The CLI formatter groups only `project` and `global`, so the
 * signed-in account's own skills join the global group: like a global skill, each is the user's,
 * not the repository's.
 */
function forPrompt(command: CustomCommand): CustomCommand {
  return {
    ...command,
    source: command.source === 'project' ? 'project' : 'global',
    description: capped(command.description),
  };
}

/**
 * The description on one line (a multi-line one would break the list) and cut to
 * {@link MAX_DESCRIPTION_CHARS}: at the last sentence end in its second half, else at a word.
 */
export function capped(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  const characters = Array.from(text);
  if (characters.length <= MAX_DESCRIPTION_CHARS) return text;
  const head = characters.slice(0, MAX_DESCRIPTION_CHARS - 3).join('');
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentence >= head.length / 2) return `${head.slice(0, sentence + 1)} ...`;
  const word = head.lastIndexOf(' ');
  return `${word > 0 ? head.slice(0, word) : head}...`;
}

/** Code-unit order rather than localeCompare, whose result depends on the host's ICU locale. */
function byGroupThenName(a: CustomCommand, b: CustomCommand): number {
  const group = Number(a.source !== 'project') - Number(b.source !== 'project');
  if (group !== 0) return group;
  return compare(a.name, b.name) || compare(a.filePath, b.filePath);
}

function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * One snapshot of the section per session, for the reason ProjectContextCache holds one of the
 * project block: the completions server puts cache_control on the system prompt, so its bytes
 * must not move between rounds or turns. A skill the user writes mid-session therefore reaches
 * the model when the session is next opened, exactly as an edit to CLAUDE.md does.
 *
 * The one mid-session change that DOES land is trusting the project, which is a decision the
 * user makes in order to use the skills behind it; `SkillCatalog.revision` is in the key so that
 * decision rebuilds the snapshot and nothing else does.
 *
 * That rebuild restates the whole list rather than sending a delta (added, changed, removed) the
 * way opencode does: the section is part of the system prompt, rebuilt from this snapshot every
 * round, and has no message of its own to carry a delta. A revision moves only on a deliberate
 * user action, so the one cache miss it costs is rare.
 */
export class SkillsPromptCache {
  private readonly entries = new Map<string, { key: string; section: Promise<string> }>();
  /** Keyed on SkillCatalog.forModel's array, which is the same one until the catalog rescans. */
  private readonly built = new WeakMap<readonly CustomCommand[], string>();

  constructor(private readonly catalog: SkillCatalog) {}

  get(sessionId: string, projectRoot: string | null): Promise<string> {
    const key = `${projectRoot ?? ''}\u0000${this.catalog.revision}`;
    const held = this.entries.get(sessionId);
    if (held && held.key === key) return held.section;
    const section = this.catalog
      .forModel(projectRoot)
      .then(commands => this.build(commands))
      .catch(() => '');
    this.entries.set(sessionId, { key, section });
    return section;
  }

  private build(commands: readonly CustomCommand[]): string {
    let section = this.built.get(commands);
    if (section === undefined) {
      section = buildSkillsSection(commands);
      this.built.set(commands, section);
    }
    return section;
  }
}

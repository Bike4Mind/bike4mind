import { buildSkillsPromptSection, type CustomCommand } from '@bike4mind/cli/skills';
import type { SkillCatalog } from './SkillCatalog';

/**
 * The list of skills the model is shown, as system-prompt text.
 *
 * Without it the `skill` tool is unreachable in practice: a model that cannot see the names has
 * nothing to pass, and the observed failure this exists to fix was a session asked "can you run
 * skills?" searching the repository for an answer. The DESCRIPTIONS are the working part - they
 * are written as trigger conditions ("Use whenever the user asks ...") and are the whole
 * mechanism by which the right skill gets picked - so they are carried whole and the bodies are
 * not carried at all.
 *
 * The formatting is the CLI's, imported rather than re-derived, for the same reason expand.ts
 * imports the argument grammar: the entry format and the "prefer a skill over doing it by hand"
 * wording should have one definition. Its worked example reads `skill({ skill: "commit" })`,
 * which is why the desktop's tool takes the same name and the same argument.
 */

/**
 * Bytes of skill list that may reach the system prompt.
 *
 * It is re-sent on every round of every turn and sits inside the cached prefix, so it is capped
 * for the same reason MAX_INSTRUCTIONS_BYTES is - a separate allowance rather than a share of
 * that one, because the two grow for unrelated reasons and a long CLAUDE.md should not silently
 * cost the user their skill list. Deliberately much smaller: a description runs to a line or two,
 * so this holds dozens of them, and a user with more than fits is told the rest are still
 * reachable by name.
 */
export const MAX_SKILLS_PROMPT_BYTES = 12_000;

/**
 * The longest one description may be. Far longer than any real one - a description is a sentence
 * or two of trigger condition - so in practice it never bites. It is what makes the allowance
 * above a ceiling rather than a target: without it, one skill with an essay in its frontmatter
 * would be the whole list, and dropping that skill instead would leave nothing listed at all.
 */
const MAX_DESCRIPTION_BYTES = 3_000;

/**
 * `commands` rendered to a bounded section, or '' when there is nothing to list.
 *
 * Entries are dropped whole rather than the text being cut mid-description, because half a
 * trigger condition reads as a complete one. Project skills are kept first and global ones
 * dropped first, matching the precedence the CLI's own grouping states.
 */
export function buildSkillsSection(commands: readonly CustomCommand[], limit = MAX_SKILLS_PROMPT_BYTES): string {
  const ordered = [
    ...commands.filter(command => command.source === 'project'),
    ...commands.filter(command => command.source !== 'project'),
  ].map(shortened);
  if (ordered.length === 0) return '';

  let kept = ordered.length;
  let section = buildSkillsPromptSection(ordered);
  while (kept > 1 && Buffer.byteLength(section) > limit) {
    kept--;
    section = withOmissionNote(buildSkillsPromptSection(ordered.slice(0, kept)), ordered.length - kept);
  }

  return section;
}

/** The description cut to {@link MAX_DESCRIPTION_BYTES}, keeping the trigger clause it opens with. */
function shortened(command: CustomCommand): CustomCommand {
  const description = Buffer.from(command.description);
  if (description.length <= MAX_DESCRIPTION_BYTES) return command;
  return { ...command, description: `${description.subarray(0, MAX_DESCRIPTION_BYTES).toString('utf8')} [...]` };
}

/**
 * Said only when something was left out. Named by count rather than listed, because listing the
 * omitted names is what the budget was spent avoiding - and the tool reaches any of them by
 * name, so an unlisted skill is hidden, not gone.
 */
function withOmissionNote(section: string, omitted: number): string {
  return `${section}\n${omitted} further skill${omitted === 1 ? ' is' : 's are'} not listed here; the skill tool still runs any of them by name.`;
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
 */
export class SkillsPromptCache {
  private readonly entries = new Map<string, { key: string; section: Promise<string> }>();

  constructor(private readonly catalog: SkillCatalog) {}

  get(sessionId: string, projectRoot: string | null): Promise<string> {
    const key = `${projectRoot ?? ''}\u0000${this.catalog.revision}`;
    const held = this.entries.get(sessionId);
    if (held && held.key === key) return held.section;
    const section = this.catalog
      .forModel(projectRoot)
      .then(commands => buildSkillsSection(commands))
      .catch(() => '');
    this.entries.set(sessionId, { key, section });
    return section;
  }
}

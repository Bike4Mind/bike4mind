import { findSkillMentions } from '@shared/skills';
import type { SkillCatalog } from './SkillCatalog';

/**
 * Skills named mid-message - `fix the login bug, then /review it` - as opposed to a leading
 * `/name`, which parseSkillInvocation turns into the whole turn.
 *
 * The message is sent as typed, and a note rides with it telling the model which skills the user
 * invoked, so it runs each through the `skill` tool. Going through the tool rather than inlining
 * the bodies keeps one path for reading a skill: the same catalog, the same `@file` confinement,
 * and the same trust reporting (an account skill still taints the reply) as a skill the model
 * picked itself.
 *
 * A name that is no skill is prose and passes untouched. A skill the user may run but the model
 * may not (`disable-model-invocation`) is refused instead: the tool would turn it down, and a
 * skill the user believes ran that in fact reached the model as the literal text is the outcome
 * the leading path already refuses over.
 */
export type InlineSkills = { note: string | null } | { error: string };

export async function resolveInlineSkills(
  text: string,
  catalog: Pick<SkillCatalog, 'get' | 'forModel'>,
  projectRoot: string | null
): Promise<InlineSkills> {
  const names = [...new Set(findSkillMentions(text).map(mention => mention.name))];
  if (names.length === 0) return { note: null };

  const known: string[] = [];
  for (const name of names) {
    if (await catalog.get(projectRoot, name)) known.push(name);
  }
  if (known.length === 0) return { note: null };

  const runnable = new Set((await catalog.forModel(projectRoot)).map(command => command.name));
  const userOnly = known.find(name => !runnable.has(name));
  if (userOnly) {
    return {
      error: `/${userOnly} can only be run at the start of a message, followed by a space or nothing. To mention it without running it, wrap it in backticks.`,
    };
  }

  const list = known.map(name => `/${name}`).join(', ');
  return {
    note:
      `The user invoked ${known.length === 1 ? 'the skill' : 'the skills'} ${list} in this message. ` +
      `Run ${known.length === 1 ? 'it' : 'each one'} with the skill tool before anything else, passing whatever ` +
      'in the message is meant for it as args, and follow the instructions it returns. Do not do the job ' +
      "from the skill's name alone.",
  };
}

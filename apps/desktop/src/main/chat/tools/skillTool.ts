import { expandSkill } from '../skills/expand';
import { requireString, type ToolContext, type ToolDefinition } from './types';

/**
 * Running a skill the way the composer's `/name` does.
 *
 * This tool READS a markdown file and returns its text. It runs nothing and changes nothing, so
 * it is ungated like the other reads here - and that is sound rather than convenient, because
 * the expanded body is instructions, not an action: every command, edit or write it then asks
 * for is an ordinary tool call that stops at the approval gate exactly as it would had the user
 * typed the same request. What the skill may READ without asking is bounded too, by expandSkill
 * putting each `@file` reference through the session's granted roots.
 *
 * The one thing it must not do is widen what a skill can reach, so it does not resolve its own
 * files, does not run the lifecycle hooks the CLI's version shells out to, and takes the set it
 * may run from the session rather than from its arguments.
 */
export const skillTool: ToolDefinition = {
  schema: {
    name: 'skill',
    description: [
      'Run one of the skills listed under "Available Skills" in your instructions, and receive',
      'its instructions to carry out.',
      '',
      'Use it whenever the work the user describes matches a skill description, and when they name',
      'a skill or type /<name>. A skill holds the way this user wants that job done; doing the job',
      'from the name alone, or from a guess at what the skill contains, is the failure this tool',
      'exists to prevent. Read the body it returns and follow it with your ordinary tools.',
      '',
      'The result is a set of instructions, not an answer or a finished result.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'The skill name as the list spells it, with or without the leading slash.',
        },
        args: {
          type: 'string',
          description:
            'What follows the name when the skill is typed as a command, verbatim. Space separated,' +
            ' with quotes around an argument that contains spaces. Omit it for a skill that takes none.',
        },
      },
      required: ['skill'],
      additionalProperties: false,
    },
  },

  async run(input, context) {
    const skills = requireSkills(context);
    const name = requireString(input, 'skill').replace(/^\//, '');
    const args = typeof input.args === 'string' ? input.args.trim() : '';

    const available = await skills.available();
    const command = available.find(candidate => candidate.name === name);
    if (!command) {
      // Named rather than a bare miss: the usual cause is a near-miss on a real skill, and a
      // model told only "not found" guesses again or abandons the skill and improvises the job.
      const names = available.map(candidate => candidate.name).join(', ');
      throw new Error(
        names
          ? `There is no skill called "${name}". These exist: ${names}.`
          : `There is no skill called "${name}", and this conversation has none available.`
      );
    }

    const expanded = await expandSkill(command, args, context.roots, context.workingDirectory);
    if (!expanded.body.trim()) throw new Error(`The skill "${name}" has an empty body, so there is nothing to run.`);

    return [`Instructions for the skill "${name}", from ${command.filePath}. Follow them.`, '', expanded.body].join(
      '\n'
    );
  },
};

function requireSkills(context: ToolContext): NonNullable<ToolContext['skills']> {
  if (!context.skills) throw new Error('This conversation has no skills available.');
  return context.skills;
}

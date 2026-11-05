import { LOOP_MERGE_TOOL_NAME } from '../../loops/guards';
import type { ToolDefinition } from './types';

/**
 * The only way a loop runner session merges a PR. The runner (main/loops) applies the stage's
 * merge policy, hold labels and CI checks; a refusal there blocks the ticket for the user.
 * Offered only in loop runner sessions, where the shell's `gh pr merge` is refused.
 */
export const loopMergePr: ToolDefinition = {
  schema: {
    name: LOOP_MERGE_TOOL_NAME,
    description: [
      "Merge this loop ticket's pull request, under the stage's merge policy.",
      '',
      'Call it once the PR is pushed and its CI has finished (`gh pr checks <url> --watch`). It merges',
      'only when every check is green, the PR is not a draft, has no conflicts and carries no hold',
      'label, and, when the stage requires it, is approved. If it refuses, the ticket is handed to',
      'the user with the reason: stop work on the ticket and say so in your final answer.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        pr_url: { type: 'string', description: 'https://github.com/<owner>/<repo>/pull/<n>' },
      },
      required: ['pr_url'],
    },
  },

  async run(input, context) {
    const loopMerge = context.loopMerge;
    if (!loopMerge) throw new Error(`${LOOP_MERGE_TOOL_NAME} is only available to a loop runner session.`);
    const url = typeof input.pr_url === 'string' ? input.pr_url.trim() : '';
    if (!url) throw new Error('Pass pr_url.');
    return loopMerge.merge(url);
  },
};

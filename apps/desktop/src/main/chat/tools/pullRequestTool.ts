import type { ToolDefinition } from './types';

export const SET_SESSION_PULL_REQUEST_TOOL_NAME = 'set_session_pull_request';

/**
 * Correcting which pull request the session's PR bar and sidebar icon follow, as the user's `/pr`
 * does. Every check is PrMonitor's own (see bindForAgent and dismiss), so the agent cannot bind
 * anything the user's path would refuse.
 *
 * Not gated: it changes only what this app shows, which the user can undo from the bar, and the
 * one GitHub read it causes is the same read a detected PR causes unasked.
 */
export const setSessionPullRequest: ToolDefinition = {
  schema: {
    name: SET_SESSION_PULL_REQUEST_TOOL_NAME,
    description: [
      "Set the pull request this session's PR bar and sidebar icon follow, or close the bar.",
      '',
      'Use it ONLY when the user asks to change, set or clear the PR for this session, or confirms a',
      'correction you offered ("that is the wrong PR, use #123", "the PR for this session is <url>").',
      'Never call it on your own after creating or pushing to a PR: the app detects that by itself.',
      '',
      'A PR set here stays until the user or you change it, or it is merged or closed; a PR detected',
      'later from `gh pr create` or `git push` output does not replace it. It is refused while',
      'auto-merge is armed on a different PR; tell the user to turn auto-merge off first.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        pull_request: {
          type: 'string',
          description:
            'A GitHub PR URL (https://github.com/<owner>/<repo>/pull/<n>), <owner>/<repo>#<n>, or #<n> for ' +
            'a PR in the same repository as the one bound now.',
        },
        clear: {
          type: 'boolean',
          description:
            "true to close the session's PR bar instead, as the user's close button does; the sidebar keeps " +
            "the PR's icon. Leave pull_request out.",
        },
      },
    },
  },

  async run(input, context) {
    const pullRequests = context.pullRequests;
    if (!pullRequests) throw new Error('This conversation has no pull request panel.');
    const target = typeof input.pull_request === 'string' ? input.pull_request.trim() : '';
    const clear = input.clear === true;
    if (clear && target) throw new Error('Pass either pull_request or clear, not both.');

    if (clear) {
      const result = await pullRequests.clear();
      if (!result.ok) throw new Error(result.error);
      context.report?.label("Cleared the session's PR");
      return "Cleared the session's pull request; the PR bar is closed.";
    }

    if (!target) throw new Error('Pass pull_request, or clear: true.');
    const result = await pullRequests.bind(target);
    if (!result.ok) throw new Error(result.error);
    const { owner, repo, number, url } = result.pr;
    context.report?.label(`Set the session's PR to ${owner}/${repo}#${number}`);
    return `The session's pull request is now ${owner}/${repo}#${number} (${url}).`;
  },
};

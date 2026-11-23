import type { SlackInteractiveActionHandler } from './interactiveActionRegistry';

export const coreSlackInteractiveActions: readonly SlackInteractiveActionHandler[] = [
  {
    actionIds: ['sre_approve_fix', 'sre_reject_fix'],
    async handle(ctx) {
      const { handleSreApprovalAction } = await import('./sreSlackApproval');
      return handleSreApprovalAction(ctx.actionId, ctx.value, ctx.user, ctx.responseUrl);
    },
  },
  {
    // Link buttons: Slack still sends an interaction for them, so acknowledge it.
    actionIdPrefixes: ['sre_view_github_issue', 'sre_review_github_issue'],
    async handle() {
      return { response: {} };
    },
  },
];

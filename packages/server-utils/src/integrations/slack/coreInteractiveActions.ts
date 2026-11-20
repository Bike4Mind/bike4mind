import type { SlackInteractiveActionHandler } from './interactiveActionRegistry';

export const coreSlackInteractiveActions: readonly SlackInteractiveActionHandler[] = [
  {
    actionIds: ['liveops_approve_issue', 'liveops_reject_issue'],
    async handle(ctx) {
      const { handleLiveopsApprovalAction } = await import('./liveopsTriageApproval');
      return handleLiveopsApprovalAction(ctx.actionId, ctx.value, ctx.user.id, {
        workspaceId: ctx.workspaceId,
        channelId: ctx.channelId,
        botToken: ctx.botToken,
      });
    },
  },
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const approvals = vi.hoisted(() => ({ liveops: vi.fn(), sre: vi.fn() }));

vi.mock('./liveopsTriageApproval', () => ({ handleLiveopsApprovalAction: approvals.liveops }));
vi.mock('./sreSlackApproval', () => ({ handleSreApprovalAction: approvals.sre }));

import { coreSlackInteractiveActions } from './coreInteractiveActions';
import { buildSlackInteractiveActionRegistry, type SlackInteractiveActionContext } from './interactiveActionRegistry';
import { SLACK_INTERACTIVE_RESERVED_ACTIONS } from './interactiveReservedActions';

const registry = buildSlackInteractiveActionRegistry(
  coreSlackInteractiveActions,
  [],
  SLACK_INTERACTIVE_RESERVED_ACTIONS
);

function context(actionId: string): SlackInteractiveActionContext {
  return {
    actionId,
    value: 'proposal-1',
    user: { id: 'U1', name: 'alice' },
    responseUrl: 'https://hooks.slack.test/response',
    channelId: 'C1',
    workspaceId: 'workspace-1',
    botToken: 'xoxb-test',
  };
}

describe('core Slack interactive actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('do not clash with each other or with the actions the endpoint reserves', () => {
    expect(() =>
      buildSlackInteractiveActionRegistry(coreSlackInteractiveActions, [], SLACK_INTERACTIVE_RESERVED_ACTIONS)
    ).not.toThrow();
  });

  it.each(['liveops_approve_issue', 'liveops_reject_issue'])('%s runs the LiveOps approval handler', async actionId => {
    const result = { response: { text: 'ok' }, deferred: Promise.resolve() };
    approvals.liveops.mockResolvedValue(result);

    const handler = registry.find(actionId);
    expect(await handler?.handle(context(actionId))).toBe(result);
    expect(approvals.liveops).toHaveBeenCalledWith(actionId, 'proposal-1', 'U1', {
      workspaceId: 'workspace-1',
      channelId: 'C1',
      botToken: 'xoxb-test',
    });
    expect(approvals.sre).not.toHaveBeenCalled();
  });

  it.each(['sre_approve_fix', 'sre_reject_fix'])('%s runs the SRE approval handler', async actionId => {
    const result = { response: { text: 'ok' } };
    approvals.sre.mockResolvedValue(result);

    const handler = registry.find(actionId);
    expect(await handler?.handle(context(actionId))).toBe(result);
    expect(approvals.sre).toHaveBeenCalledWith(
      actionId,
      'proposal-1',
      { id: 'U1', name: 'alice' },
      'https://hooks.slack.test/response'
    );
    expect(approvals.liveops).not.toHaveBeenCalled();
  });

  it.each(['sre_view_github_issue', 'sre_view_github_issue_123', 'sre_review_github_issue_fix_loop'])(
    '%s is acknowledged with an empty response and no approval handler',
    async actionId => {
      const handler = registry.find(actionId);

      expect(await handler?.handle(context(actionId))).toEqual({ response: {} });
      expect(approvals.liveops).not.toHaveBeenCalled();
      expect(approvals.sre).not.toHaveBeenCalled();
    }
  );

  it('registers nothing for other ids', () => {
    expect(registry.find('app_home_help')).toBeUndefined();
    expect(registry.find('sre_other_action')).toBeUndefined();
  });
});

import { randomUUID } from 'node:crypto';
import { escapeSlackText, LiveopsTriageConfigSchema } from '@bike4mind/common';
import { AdminSettings, cacheRepository, liveopsTriageConfigRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import type { KnownBlock } from '@slack/web-api';
import { WebClient } from '@slack/web-api';
import { createIssueTracker } from '../../services/issueTrackers/index';
import { GitHubIssueTracker } from '../../services/issueTrackers/githubIssueTracker';
import type { CreateIssueParams } from '../../services/issueTrackers/types';

const logger = new Logger();
const TTL_MS = 24 * 60 * 60 * 1000;
const keyFor = (id: string) => `liveops:proposal:${id}`;

interface ApprovalConfig {
  approverIds?: string;
  autoCreateIssues?: boolean;
  slackWorkspaceId?: { toString(): string } | string;
  slackChannelId: string;
  slackOutputChannelId?: string;
  organizationId?: string;
  issueTracker?: string;
  githubOwner?: string;
  githubRepo?: string;
  jiraProjectKey?: string;
  jiraIssueType?: string;
}

function targetFor(config: ApprovalConfig): string {
  return JSON.stringify([
    config.organizationId || '',
    config.issueTracker || 'github',
    config.githubOwner || '',
    config.githubRepo || '',
    config.jiraProjectKey || '',
    config.jiraIssueType || 'Bug',
  ]);
}

interface Proposal {
  configId?: string;
  workspaceId?: string;
  channelId: string;
  target: string;
  issue: CreateIssueParams;
}

export async function createLiveopsProposalBlocks(
  config: ApprovalConfig,
  issue: CreateIssueParams,
  configId?: string
): Promise<KnownBlock[]> {
  const id = randomUUID();
  const proposal: Proposal = {
    configId,
    workspaceId: config.slackWorkspaceId?.toString(),
    channelId: config.slackOutputChannelId || config.slackChannelId,
    target: targetFor(config),
    issue,
  };
  await cacheRepository.createOrUpdate({
    key: keyFor(id),
    result: proposal,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Proposed issue (${issue.priority}):* ${escapeSlackText(issue.title.slice(0, 500))}\n${escapeSlackText(issue.body.slice(0, 1000))}`,
      },
    },
    {
      type: 'actions',
      block_id: id,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve' },
          style: 'primary',
          action_id: 'liveops_approve_issue',
          value: id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject' },
          style: 'danger',
          action_id: 'liveops_reject_issue',
          value: id,
        },
      ],
    },
  ];
}

export async function handleLiveopsApprovalAction(
  actionId: string,
  proposalId: string | undefined,
  userId: string,
  context: { workspaceId?: string; channelId?: string; botToken?: string }
): Promise<{ response: Record<string, unknown>; deferred?: Promise<void> }> {
  const reply = async (text: string) => {
    if (context.botToken && context.channelId) {
      try {
        await new WebClient(context.botToken).chat.postEphemeral({ channel: context.channelId, user: userId, text });
      } catch (error) {
        logger.error('Failed to acknowledge LiveOps proposal action', { error });
      }
    }
    return { response: { response_type: 'ephemeral', text } };
  };
  if (
    !proposalId ||
    !/^[0-9a-f-]{36}$/.test(proposalId) ||
    !['liveops_approve_issue', 'liveops_reject_issue'].includes(actionId)
  ) {
    return reply('Invalid LiveOps proposal.');
  }
  const cached = await cacheRepository.findByKey(keyFor(proposalId));
  if (!cached) return reply('Proposal expired or already processed.');
  const proposal = cached.result as Proposal;
  const storedConfig = proposal.configId ? await liveopsTriageConfigRepository.findById(proposal.configId) : null;
  const legacySetting = proposal.configId
    ? null
    : await AdminSettings.findOne({ settingName: 'liveopsTriageConfig' }).lean().exec();
  const parsedLegacy = LiveopsTriageConfigSchema.safeParse(legacySetting?.settingValue);
  const config = proposal.configId ? storedConfig : parsedLegacy.success ? parsedLegacy.data : null;
  if (
    !config ||
    !config.autoCreateIssues ||
    !proposal.workspaceId ||
    context.workspaceId !== proposal.workspaceId ||
    config.slackWorkspaceId?.toString() !== proposal.workspaceId ||
    context.channelId !== proposal.channelId ||
    (config.slackOutputChannelId || config.slackChannelId) !== proposal.channelId ||
    targetFor(config) !== proposal.target ||
    !context.botToken ||
    !(config.approverIds || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean)
      .includes(userId)
  ) {
    return reply('You are not authorized to process this LiveOps proposal.');
  }

  // Consume before any external side effect; ambiguous tracker failures must not be retried.
  const claimed = await cacheRepository.deleteByKeyAndReturn(keyFor(proposalId));
  if (!claimed || !claimed.expiresAt || new Date(claimed.expiresAt).getTime() <= Date.now()) {
    return reply('Proposal expired or already processed.');
  }
  if (actionId === 'liveops_reject_issue') return reply('LiveOps proposal rejected.');

  const deferred = (async () => {
    try {
      const tracker = storedConfig
        ? createIssueTracker(storedConfig, logger)
        : new GitHubIssueTracker(config.githubOwner!, config.githubRepo!, logger);
      const issue = await tracker.createIssue((claimed.result as Proposal).issue);
      if (!issue) throw new Error('Tracker did not return an issue');
      await new WebClient(context.botToken).chat.postMessage({
        channel: proposal.channelId,
        text: `${proposal.issue.priority === 'P0' ? '<!here> ' : ''}Approved LiveOps issue: <${issue.url.replace(/[<>|\r\n]/g, '')}|${escapeSlackText(issue.key)}>`,
        unfurl_links: false,
      });
    } catch (error) {
      logger.error('Failed to process approved LiveOps proposal', { error, proposalId });
    }
  })();
  return { ...(await reply('LiveOps proposal approved. Processing issue creation.')), deferred };
}

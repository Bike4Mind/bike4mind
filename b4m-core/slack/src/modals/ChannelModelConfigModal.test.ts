/**
 * Tests for Channel Model Config Modal
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildChannelModelConfigModal,
  parseChannelModelConfigSubmission,
  CHANNEL_MODEL_CONFIG_CALLBACK_ID,
} from './ChannelModelConfigModal';

vi.mock('../constants/slack-model-options', () => ({
  buildSlackModelOptionsFromDashboard: vi.fn().mockResolvedValue({
    option_groups: [
      {
        label: { type: 'plain_text', text: 'Anthropic' },
        options: [{ text: { type: 'plain_text', text: 'Claude Sonnet 5' }, value: 'claude-sonnet-5' }],
      },
    ],
    flat: [{ text: { type: 'plain_text', text: 'Claude Sonnet 5' }, value: 'claude-sonnet-5' }],
  }),
}));

const baseValues = {
  channel_block: { channel_select: { selected_channel: 'C12345' } },
};

const metadata = JSON.stringify({ slackTeamId: 'T12345' });

describe('ChannelModelConfigModal', () => {
  describe('buildChannelModelConfigModal', () => {
    it('should include GitHub owner and repo input blocks', async () => {
      const modal = await buildChannelModelConfigModal({ slackTeamId: 'T12345' });

      expect(modal.callback_id).toBe(CHANNEL_MODEL_CONFIG_CALLBACK_ID);
      const blockIds = (modal.blocks || []).map((b: { block_id?: string }) => b.block_id);
      expect(blockIds).toContain('github_owner_block');
      expect(blockIds).toContain('github_repo_block');
    });

    it('should prefill GitHub owner and repo in edit mode', async () => {
      const modal = await buildChannelModelConfigModal({
        slackTeamId: 'T12345',
        channelId: 'C12345',
        githubOwner: 'my-org',
        githubRepo: 'my-repo',
      });

      const ownerBlock = (modal.blocks || []).find(
        (b: { block_id?: string }) => b.block_id === 'github_owner_block'
      ) as { element?: { initial_value?: string } };
      const repoBlock = (modal.blocks || []).find((b: { block_id?: string }) => b.block_id === 'github_repo_block') as {
        element?: { initial_value?: string };
      };

      expect(ownerBlock?.element?.initial_value).toBe('my-org');
      expect(repoBlock?.element?.initial_value).toBe('my-repo');
    });

    it('should not set initial_value when no GitHub default configured', async () => {
      const modal = await buildChannelModelConfigModal({ slackTeamId: 'T12345', channelId: 'C12345' });

      const ownerBlock = (modal.blocks || []).find(
        (b: { block_id?: string }) => b.block_id === 'github_owner_block'
      ) as { element?: { initial_value?: string } };

      expect(ownerBlock?.element?.initial_value).toBeUndefined();
    });
  });

  describe('parseChannelModelConfigSubmission', () => {
    it('should accept owner and repo together', () => {
      const result = parseChannelModelConfigSubmission(
        {
          ...baseValues,
          github_owner_block: { github_owner_input: { value: 'my-org' } },
          github_repo_block: { github_repo_input: { value: 'my-repo' } },
        },
        metadata
      );

      expect(result).toMatchObject({ channelId: 'C12345', githubOwner: 'my-org', githubRepo: 'my-repo' });
    });

    it('should trim whitespace and normalize empty strings to undefined', () => {
      const result = parseChannelModelConfigSubmission(
        {
          ...baseValues,
          github_owner_block: { github_owner_input: { value: '  my-org  ' } },
          github_repo_block: { github_repo_input: { value: ' my-repo ' } },
        },
        metadata
      );

      expect(result).toMatchObject({ githubOwner: 'my-org', githubRepo: 'my-repo' });

      const empty = parseChannelModelConfigSubmission(
        {
          ...baseValues,
          github_owner_block: { github_owner_input: { value: '  ' } },
          github_repo_block: { github_repo_input: { value: '' } },
        },
        metadata
      );

      expect(empty).toMatchObject({ channelId: 'C12345' });
      expect((empty as { githubOwner?: string }).githubOwner).toBeUndefined();
      expect((empty as { githubRepo?: string }).githubRepo).toBeUndefined();
    });

    it('should reject owner without repo (and vice versa)', () => {
      const ownerOnly = parseChannelModelConfigSubmission(
        {
          ...baseValues,
          github_owner_block: { github_owner_input: { value: 'my-org' } },
        },
        metadata
      );
      expect(ownerOnly).toMatchObject({ errorBlock: 'github_repo_block' });
      expect((ownerOnly as { error?: string }).error).toContain('both');

      const repoOnly = parseChannelModelConfigSubmission(
        {
          ...baseValues,
          github_repo_block: { github_repo_input: { value: 'my-repo' } },
        },
        metadata
      );
      expect(repoOnly).toMatchObject({ errorBlock: 'github_owner_block' });
    });

    it('should reject invalid owner and repo formats', () => {
      const badOwner = parseChannelModelConfigSubmission(
        {
          ...baseValues,
          github_owner_block: { github_owner_input: { value: '-bad-owner-' } },
          github_repo_block: { github_repo_input: { value: 'my-repo' } },
        },
        metadata
      );
      expect(badOwner).toMatchObject({ errorBlock: 'github_owner_block' });

      const badRepo = parseChannelModelConfigSubmission(
        {
          ...baseValues,
          github_owner_block: { github_owner_input: { value: 'my-org' } },
          github_repo_block: { github_repo_input: { value: 'owner/repo' } },
        },
        metadata
      );
      expect(badRepo).toMatchObject({ errorBlock: 'github_repo_block' });
    });

    it('should still parse model settings without GitHub fields', () => {
      const result = parseChannelModelConfigSubmission(
        {
          ...baseValues,
          model_block: { model_select: { selected_option: { value: 'claude-sonnet-5' } } },
          temperature_block: { temperature_input: { value: '0.7' } },
          max_tokens_block: { max_tokens_input: { value: '4000' } },
        },
        metadata
      );

      expect(result).toMatchObject({
        channelId: 'C12345',
        preferredModel: 'claude-sonnet-5',
        temperature: 0.7,
        maxTokens: 4000,
      });
    });
  });
});

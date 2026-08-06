/**
 * Tests for the Agent Command Parser
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseCommand,
  selectAgent,
  buildSystemPrompt,
  parseImageModelOverride,
  parseDataLakeCommand,
  isDataLakeCommand,
  AGENT_REGISTRY,
} from './agent-parser';
import { ImageModels } from '@bike4mind/common';

// Prevent importing SST Resource-backed modules during unit tests.
vi.mock('@server/utils/mcpEnv', () => ({
  buildMcpEnvVariables: vi.fn(async () => []),
}));

vi.mock('@server/utils/storage', () => {
  const filesStorage = {
    download: vi.fn(async () => Buffer.from('')),
    getSignedUrl: vi.fn(async () => 'https://example.com/presigned'),
    upload: vi.fn(async () => undefined),
  };
  const generatedImageStorage = {
    download: vi.fn(async () => Buffer.from('')),
    getSignedUrl: vi.fn(async () => 'https://example.com/presigned'),
    upload: vi.fn(async () => undefined),
  };
  return {
    getFilesStorage: () => filesStorage,
    getGeneratedImageStorage: () => generatedImageStorage,
  };
});

describe('Agent Command Parser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseCommand', () => {
    it('should parse basic agent commands', () => {
      const result = parseCommand('@agent please summarize this thread');
      expect(result.agentName).toBe('agent');
      expect(result.command).toBe('@agent please summarize this thread');
      expect(result.rawText).toBe('@agent please summarize this thread');
    });

    it('should parse PM agent commands', () => {
      const result = parseCommand('@pm please create a Jira epic from this conversation');
      expect(result.agentName).toBe('pm');
      expect(result.command).toBe('@pm please create a Jira epic from this conversation');
    });

    it('should parse developer agent commands', () => {
      const result = parseCommand('@dev please create a GitHub issue about the bug Mary mentioned');
      expect(result.agentName).toBe('dev');
      expect(result.command).toBe('@dev please create a GitHub issue about the bug Mary mentioned');
    });

    it('should handle Slack user mentions before agent mention', () => {
      const result = parseCommand('<@U12345> @agent please help');
      expect(result.agentName).toBe('agent');
      expect(result.command).toBe('<@U12345> @agent please help');
    });

    it('should preserve user mentions in command for assignee extraction', () => {
      const result = parseCommand('@dev assign to <@U09JUQJ2KHC>');
      expect(result.agentName).toBe('dev');
      expect(result.command).toBe('@dev assign to <@U09JUQJ2KHC>');
    });

    it('should parse commands without agent mentions', () => {
      const result = parseCommand('just a regular message');
      expect(result.agentName).toBeNull();
      expect(result.command).toBe('just a regular message');
    });

    it('should parse multi-line commands correctly', () => {
      const multiLineCommand =
        '@pm Here\n1. "Top 5 Thriller Books"\n2. For content, please add the top 5 thriller books';
      const result = parseCommand(multiLineCommand);

      expect(result.agentName).toBe('pm');
      expect(result.command).toContain('Here');
      expect(result.command).toContain('Top 5 Thriller Books');
    });
  });

  describe('selectAgent', () => {
    it('should select specified agent if valid', () => {
      const command = { agentName: 'pm', command: 'do something', rawText: '@pm do something' };
      expect(selectAgent(command).name).toBe('Project Manager');
    });

    it('should select dev agent when specified', () => {
      const command = { agentName: 'dev', command: 'do something', rawText: '@dev do something' };
      expect(selectAgent(command).name).toBe('Developer');
    });

    it('should default to general agent for @agent', () => {
      const command = { agentName: 'agent', command: 'do something', rawText: '@agent do something' };
      expect(selectAgent(command).name).toBe('General Agent');
    });

    it('should default to general agent when no agent mentioned', () => {
      const command = { agentName: null, command: 'do something', rawText: 'do something' };
      expect(selectAgent(command).name).toBe('General Agent');
    });
  });

  describe('buildSystemPrompt', () => {
    it('should include slash command instructions', async () => {
      const prompt = await buildSystemPrompt();
      expect(prompt).toContain('Available Slash Commands');
      expect(prompt).toContain('slackbot_help');
      expect(prompt).toContain('notebook_new');
    });

    it('should include agent routing instructions', async () => {
      const prompt = await buildSystemPrompt();
      expect(prompt).toContain('Agent Routing');
      expect(prompt).toContain('github_manager');
      expect(prompt).toContain('project_manager');
    });

    it('should include navigate_view guard', async () => {
      const prompt = await buildSystemPrompt();
      expect(prompt).toContain('navigate_view');
    });

    it('should include pending action context when provided', async () => {
      const prompt = await buildSystemPrompt({
        pendingAction: {
          tool: 'github_create_issue',
          params: { title: 'Test issue' },
          ts: Date.now() - 60000, // 1 minute ago
        },
      });
      expect(prompt).toContain('PENDING ACTION');
      expect(prompt).toContain('github_create_issue');
      expect(prompt).toContain('confirm_pending_action');
    });

    it('should include conversation context when provided', async () => {
      const prompt = await buildSystemPrompt({
        channelMessages: [
          { user: 'U123', text: 'Hello there' },
          { bot_id: 'B123', text: 'Hi! How can I help?' },
        ],
        getUserName: async (userId: string) => (userId === 'U123' ? 'Alice' : 'Unknown'),
      });
      expect(prompt).toContain('Recent Slack conversation');
      expect(prompt).toContain('Alice: Hello there');
      expect(prompt).toContain('[Bot]: Hi! How can I help?');
    });

    it('should include image generation routing instructions', async () => {
      const prompt = await buildSystemPrompt();
      expect(prompt).toContain('Image Generation');
      expect(prompt).toContain('image_generation');
    });
  });
});

describe('parseImageModelOverride', () => {
  it('should parse "with flux-pro"', () => {
    expect(parseImageModelOverride('generate image with flux-pro')).toBe(ImageModels.FLUX_PRO_1_1);
  });

  it('should parse "with flux ultra"', () => {
    expect(parseImageModelOverride('create picture with flux ultra')).toBe(ImageModels.FLUX_PRO_ULTRA);
  });

  it('should parse "with gpt-image"', () => {
    expect(parseImageModelOverride('generate image with gpt-image')).toBe(ImageModels.GPT_IMAGE_1_5);
  });

  it('should parse "using openai"', () => {
    expect(parseImageModelOverride('create image using openai')).toBe(ImageModels.GPT_IMAGE_1_5);
  });

  it('should return undefined when no model specified', () => {
    expect(parseImageModelOverride('create a picture of a cat')).toBeUndefined();
  });

  it('should prefer "flux ultra" over "flux" (more specific match first)', () => {
    expect(parseImageModelOverride('generate with flux ultra')).toBe(ImageModels.FLUX_PRO_ULTRA);
  });

  it('should NOT false-positive on "flux capacitor" without with/using prefix', () => {
    expect(parseImageModelOverride('generate an image of a flux capacitor')).toBeUndefined();
  });

  it('should NOT false-positive on "openai is great" without with/using prefix', () => {
    expect(parseImageModelOverride('tell me about openai models')).toBeUndefined();
  });

  it('should NOT false-positive on "with flux-powered engines"', () => {
    expect(parseImageModelOverride('draw a robot with flux-powered engines')).toBeUndefined();
  });
});

describe('@datalake command', () => {
  it('registers `datalake` in AGENT_REGISTRY so the channel-gate pattern matches it', () => {
    expect(AGENT_REGISTRY.datalake).toBeDefined();
  });

  it('isDataLakeCommand is true only for the datalake agent', () => {
    expect(isDataLakeCommand(parseCommand('@datalake add to sales https://x.com'))).toBe(true);
    expect(isDataLakeCommand(parseCommand('@dev create an issue'))).toBe(false);
    expect(isDataLakeCommand(parseCommand('summarize this thread'))).toBe(false);
  });

  it('intercepts a bare `@datalake` mention with no args (would otherwise leak to the LLM)', () => {
    expect(isDataLakeCommand(parseCommand('@datalake'))).toBe(true);
    expect(isDataLakeCommand(parseCommand('@datalake   '))).toBe(true);
    expect(isDataLakeCommand(parseCommand('<@U12345> @datalake'))).toBe(true);
    // not a leading mention, and word-boundary guard
    expect(isDataLakeCommand(parseCommand('hey @datalake'))).toBe(false);
    expect(isDataLakeCommand(parseCommand('@datalaked add'))).toBe(false);
  });

  it('selectAgent never routes @datalake to an LLM persona (falls back to the general agent)', () => {
    expect(selectAgent(parseCommand('@datalake add to sales https://x.com'))).toBe(AGENT_REGISTRY.agent);
    // sanity: a real persona still resolves
    expect(selectAgent(parseCommand('@dev create an issue'))).toBe(AGENT_REGISTRY.dev);
  });

  describe('parseDataLakeCommand grammar', () => {
    it('parses `add to <lake> <link>`', () => {
      const r = parseDataLakeCommand('@datalake add to sales https://example.com/doc');
      expect(r).toMatchObject({ subcommand: 'add', lakeSlug: 'sales', link: 'https://example.com/doc' });
    });

    it('parses `add <link> to <lake>` (order-independent)', () => {
      const r = parseDataLakeCommand('@datalake add https://example.com/doc to sales');
      expect(r).toMatchObject({ subcommand: 'add', lakeSlug: 'sales', link: 'https://example.com/doc' });
    });

    it('parses `add to <lake>` with no link (file-attachment case)', () => {
      const r = parseDataLakeCommand('@datalake add to sales');
      expect(r).toMatchObject({ subcommand: 'add', lakeSlug: 'sales' });
      expect(r.link).toBeUndefined();
    });

    it('does not treat a URL as the lake slug when written as `add to <link>`', () => {
      const r = parseDataLakeCommand('@datalake add to https://example.com/doc');
      expect(r.subcommand).toBe('add');
      expect(r.lakeSlug).toBeUndefined();
      expect(r.link).toBe('https://example.com/doc');
    });

    it('unwraps a Slack-formatted URL `<url>` in the link', () => {
      const r = parseDataLakeCommand('@datalake add <https://example.com/doc> to sales');
      expect(r).toMatchObject({ subcommand: 'add', lakeSlug: 'sales', link: 'https://example.com/doc' });
    });

    it('strips the `|label` from a Slack `<url|label>` link', () => {
      const r = parseDataLakeCommand('@datalake add <https://example.com/doc|My Doc> to sales');
      expect(r.link).toBe('https://example.com/doc');
      expect(r.lakeSlug).toBe('sales');
    });

    it('does not treat a Slack-wrapped URL as the lake slug in `add to <link>`', () => {
      const r = parseDataLakeCommand('@datalake add to <https://example.com/doc>');
      expect(r.subcommand).toBe('add');
      expect(r.lakeSlug).toBeUndefined();
      expect(r.link).toBe('https://example.com/doc');
    });

    it('anchors the `to <lake>` capture to the add subcommand only', () => {
      expect(parseDataLakeCommand('@datalake list to sales').lakeSlug).toBeUndefined();
      expect(parseDataLakeCommand('@datalake help to sales').lakeSlug).toBeUndefined();
    });

    it('strips a Slack-wrapped slug symmetrically (leading < and trailing >)', () => {
      expect(parseDataLakeCommand('@datalake add to <sales>').lakeSlug).toBe('sales');
    });

    it('parses `list` and `help`', () => {
      expect(parseDataLakeCommand('@datalake list').subcommand).toBe('list');
      expect(parseDataLakeCommand('@datalake help').subcommand).toBe('help');
    });

    it('treats a bare `@datalake` as help', () => {
      expect(parseDataLakeCommand('@datalake').subcommand).toBe('help');
    });

    it('flags an unrecognized subcommand', () => {
      expect(parseDataLakeCommand('@datalake frobnicate stuff').subcommand).toBe('unknown');
    });

    it('strips leading Slack user mentions before the @datalake token', () => {
      const r = parseDataLakeCommand('<@U12345> @datalake add to sales https://example.com/doc');
      expect(r).toMatchObject({ subcommand: 'add', lakeSlug: 'sales', link: 'https://example.com/doc' });
    });
  });
});

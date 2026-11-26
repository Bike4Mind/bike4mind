import { describe, it, expect, vi } from 'vitest';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { ApiKeyType, CreditHolderType, type IUsageEventInput } from '@bike4mind/common';
import { getEffectiveApiKey } from '../../apiKeyService';
import {
  applyExampleRunPolicy,
  exampleRunToolMode,
  exampleRunWiring,
  platformPaidUsageEvent,
  withoutUserApiKeys,
  exampleStepLabel,
  simulatedToolResult,
  type ExampleRunStep,
} from './exampleRunTools';

describe('exampleRunToolMode', () => {
  it.each([
    // Connector tools: always simulated, reads included.
    ['github__search_issues', 'simulated'],
    ['github__create_issue_comment', 'simulated'],
    ['atlassian__get_page', 'simulated'],
    ['slack__send_message', 'simulated'],
    // Built-in tools with outside side effects.
    ['blog_publish', 'simulated'],
    ['save_content_to_data_lake', 'simulated'],
    ['edit_file', 'simulated'],
    ['excel_generation', 'simulated'],
    ['send_slack_message', 'simulated'],
    ['bash_execute', 'simulated'],
    // The author's private workspace.
    ['search_knowledge_base', 'simulated'],
    ['retrieve_knowledge_content', 'simulated'],
    ['list_my_data_lakes', 'simulated'],
    ['file_read', 'simulated'],
    ['notebook_status', 'simulated'],
    ['skill', 'simulated'],
    // Undeclared.
    ['some_new_tool', 'simulated'],
    // Public, computed or generated: real.
    ['web_search', 'real'],
    ['web_fetch', 'real'],
    ['math_evaluate', 'real'],
    ['current_datetime', 'real'],
    ['deep_research', 'real'],
    ['mermaid_chart', 'real'],
    ['recharts', 'real'],
    ['image_generation', 'real'],
    ['edit_image', 'real'],
    ['video_generation', 'real'],
    ['music_generation', 'real'],
    ['delegate_to_agent', 'real'],
  ])('%s is %s', (name, mode) => {
    expect(exampleRunToolMode(name)).toBe(mode);
  });
});

describe('exampleStepLabel', () => {
  it.each([
    ['github__search_issues', {}, 'Searched issues in example-org/app'],
    ['github__create_issue_comment', {}, 'Created issue comment in example-org/app'],
    ['linear__list_projects', {}, 'Listed projects in linear'],
    ['video_generation', { width: 1080, height: 1920 }, 'Rendered 1080x1920 video'],
    ['image_generation', {}, 'Generated an image'],
    ['web_search', { query: ' solar panels ' }, 'Searched the web for "solar panels"'],
    ['web_fetch', { url: 'https://example.com/a' }, 'Read example.com'],
    ['web_fetch', { url: 'not a url' }, 'Read a web page'],
    ['frobnicate', {}, 'Ran frobnicate'],
  ])('%s -> %s', (name, params, label) => {
    expect(exampleStepLabel(name, params)).toBe(label);
  });

  it('keeps a label within 80 characters', () => {
    expect(exampleStepLabel('web_search', { query: 'x'.repeat(200) }).length).toBe(80);
  });
});

describe('simulatedToolResult', () => {
  it('returns placeholder data only', () => {
    const read = JSON.parse(simulatedToolResult('github__list_issues'));
    expect(read.simulated).toBe(true);
    expect(read.result.items[0]).toMatchObject({ repository: 'example-org/app', owner: 'example-user' });
    const write = JSON.parse(simulatedToolResult('github__create_issue'));
    expect(write.result).toMatchObject({ status: 'ok', repository: 'example-org/app' });
  });
});

describe('applyExampleRunPolicy', () => {
  const tool = (name: string): ICompletionOptionTools => ({
    toolFn: vi.fn(async () => `real ${name}`),
    toolSchema: { name, description: name, parameters: { type: 'object', properties: {} } },
  });

  it('runs real tools, simulates the rest and records a step for each call', async () => {
    const steps: ExampleRunStep[] = [];
    const real = tool('web_search');
    const connector = tool('github__create_issue');
    const [wrappedReal, wrappedConnector] = applyExampleRunPolicy([real, connector], { onStep: s => steps.push(s) });

    expect(await wrappedReal.toolFn({ query: 'q' })).toBe('real web_search');
    expect(JSON.parse(await wrappedConnector.toolFn({}))).toMatchObject({ simulated: true });
    expect(connector.toolFn).not.toHaveBeenCalled();
    expect(steps).toEqual([
      { label: 'Searched the web for "q"', simulated: false },
      { label: 'Created issue in example-org/app', simulated: true },
    ]);
  });
});

describe('exampleRunWiring', () => {
  const tool = (name: string, toolFn = vi.fn(async () => 'real')): ICompletionOptionTools => ({
    toolSchema: { name, description: '', parameters: { type: 'object', properties: {} } },
    toolFn,
  });

  it('changes nothing on a normal turn', () => {
    const wiring = exampleRunWiring(undefined);
    const tools = [tool('github__create_issue')];
    expect(wiring.apiKeyOwner('user-1')).toBe('user-1');
    expect(wiring.enforceCredits(true)).toBe(true);
    expect(wiring.payerGates).toBe(true);
    expect(wiring.researchModeAllowed).toBe(true);
    expect(wiring.tools(tools)).toBe(tools);
    expect(wiring.childTools).toBeUndefined();
    const db = { apiKeys: { findByUserIdAndType: vi.fn(), findByUserIdAndTypes: vi.fn() } };
    expect(wiring.toolDb(db)).toBe(db);
    expect(wiring.pinnedSkill).toBeUndefined();
    expect(wiring.recordsPlatformUsage).toBe(false);
    const usageEvents = { record: vi.fn() };
    expect(wiring.usageEvents(usageEvents)).toBe(usageEvents);
  });

  it('takes platform keys, drops the payer gates and research mode, and pins the skill in an example run', () => {
    const skill = { name: 'launch-plan', body: 'Plan it' };
    const wiring = exampleRunWiring({ onStep: vi.fn(), skill });
    expect(wiring.apiKeyOwner('user-1')).toBeNull();
    expect(wiring.enforceCredits(true)).toBe(false);
    expect(wiring.payerGates).toBe(false);
    expect(wiring.researchModeAllowed).toBe(false);
    expect(wiring.pinnedSkill).toBe(skill);
  });

  it.each(['tools', 'childTools'] as const)(
    'puts %s (main tools and deferred declarations, or a subagent) behind the dry-run policy',
    async which => {
      const steps: ExampleRunStep[] = [];
      const wrap = exampleRunWiring({ onStep: step => steps.push(step) })[which]!;
      const realFn = vi.fn(async () => 'posted');
      const [wrapped] = wrap([tool('github__create_issue', realFn)]);
      expect(JSON.parse(String(await wrapped.toolFn({})))).toMatchObject({ simulated: true });
      expect(realFn).not.toHaveBeenCalled();
      expect(steps).toHaveLength(1);
    }
  );
});

describe('withoutUserApiKeys', () => {
  const db = {
    apiKeys: {
      findByUserIdAndType: vi.fn(async () => ({ apiKey: 'author-own-key' })),
      findByUserIdAndTypes: vi.fn(async () => [{ apiKey: 'author-own-key' }]),
      other: vi.fn(() => 'kept'),
    },
    adminSettings: { findBySettingName: vi.fn(async () => ({ settingValue: 'platform-key' })) },
  };

  it("resolves the image tools' provider key from the platform, never the author's saved key", async () => {
    const adapters = { db: db as never };
    expect(await getEffectiveApiKey('author-1', { type: ApiKeyType.openai }, adapters)).toBe('author-own-key');
    expect(
      await getEffectiveApiKey('author-1', { type: ApiKeyType.openai }, { db: withoutUserApiKeys(db) as never })
    ).toBe('platform-key');
  });

  it('keeps the rest of the repository', async () => {
    const wrapped = withoutUserApiKeys(db);
    expect(await wrapped.apiKeys.findByUserIdAndTypes()).toEqual([]);
    expect(wrapped.apiKeys.other()).toBe('kept');
    expect(wrapped.adminSettings).toBe(db.adminSettings);
  });
});

describe('platform-paid usage', () => {
  const authorEvent: IUsageEventInput = {
    requestId: 'quest-1',
    userId: 'author-1',
    ownerId: 'org-1',
    ownerType: CreditHolderType.Organization,
    sessionId: 'session-1',
    projectId: 'project-1',
    feature: 'chat',
    provider: 'anthropic',
    model: 'claude',
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.0025,
    creditsCharged: 5,
    reservedCredits: 9,
    source: 'web',
    status: 'ok',
  };

  it('re-owns a row to the platform, keeps its cost and charges nothing', () => {
    expect(platformPaidUsageEvent(authorEvent, 'listing-1')).toMatchObject({
      requestId: 'quest-1',
      userId: 'platform',
      ownerId: 'platform',
      ownerType: 'Platform',
      projectId: undefined,
      source: 'system',
      model: 'claude',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0025,
      creditsCharged: 0,
      reservedCredits: undefined,
      platformPaid: { reason: 'template_example_run', listingId: 'listing-1' },
    });
  });

  it('records the settlement row and tool rows of an example run against the platform', async () => {
    const wiring = exampleRunWiring({ onStep: vi.fn(), listingId: 'listing-1' });
    expect(wiring.recordsPlatformUsage).toBe(true);
    const record = vi.fn(async () => null);
    const usageEvents = { record, summary: vi.fn(() => 'kept') };

    await wiring.usageEvents(usageEvents)!.record(authorEvent);
    expect(wiring.usageEvents(usageEvents)!.summary()).toBe('kept');

    const operationalBilling = { creditTransactions: {} };
    const toolDb = wiring.toolDb({
      apiKeys: { findByUserIdAndType: vi.fn(), findByUserIdAndTypes: vi.fn() },
      usageEvents,
      operationalBilling,
    });
    await toolDb.usageEvents!.record({ ...authorEvent, feature: 'operations' });

    expect(record).toHaveBeenCalledTimes(2);
    for (const [event] of record.mock.calls as unknown as [IUsageEventInput][]) {
      expect(event).toMatchObject({
        ownerType: 'Platform',
        ownerId: 'platform',
        userId: 'platform',
        creditsCharged: 0,
      });
    }
    expect(toolDb.operationalBilling).toBeUndefined();
  });
});

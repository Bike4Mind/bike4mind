import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ForbiddenError,
  getToolSideEffects,
  ORG_MODEL_NOT_ALLOWED_ERROR_CODE,
  type ReadOrgModelPolicy,
} from '@bike4mind/common';
import { b4mTools, generateTools } from '../llm/tools';
import { createToolModelAdmission } from '../llm/tools/helpers/modelAdmission';
import {
  buildProactiveMessageMessages,
  generateAndSendProactiveMessage,
  proactiveMessageTools,
  proactiveMessageToolsFor,
} from './generateAndSend';

const h = vi.hoisted(() => ({
  complete: vi.fn(),
  generateTools: vi.fn(),
}));

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn(async () => [{ id: 'claude-sonnet-4-6', backend: 'anthropic' }]),
  getLlmByModel: vi.fn(() => ({ complete: h.complete })),
}));

vi.mock('../llm/tools', async importOriginal => ({
  ...(await importOriginal<typeof import('../llm/tools')>()),
  generateTools: h.generateTools,
}));
import type {
  IAgentDocument,
  IChatHistoryItem,
  ISessionAgentConfigDocument,
  ISessionDocument,
} from '@bike4mind/common';

/**
 * Wiring the behavioral harness below cannot observe is pinned at the source, like the agentExecutor wiring in
 * apps/workers/src/queueHandlers/agentExecutor.lakeWriteTools.e2e.test.ts.
 */
describe('generateAndSendProactiveMessage tool deps', () => {
  const source = readFileSync(join(__dirname, 'generateAndSend.ts'), 'utf8');

  // The tool map is structural, so it can be asserted without standing up the message run.
  it('never offers decide, which has no injected runner on this surface', () => {
    expect(Object.keys(b4mTools)).toContain('decide'); // non-vacuous: the registry still has it
    expect(Object.keys(proactiveMessageTools)).not.toContain('decide');
  });

  it('offers only tools that declare no side effect beyond the reply', () => {
    const names = Object.keys(proactiveMessageTools);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(['none', 'local']).toContain(getToolSideEffects(name));
    for (const name of ['blog_publish', 'blog_edit', 'blog_draft', 'image_generation', 'edit_image', 'edit_file']) {
      expect(Object.keys(b4mTools)).toContain(name);
      expect(names).not.toContain(name);
    }
  });

  it('never offers the model-chosen URL fetchers', () => {
    expect(Object.keys(proactiveMessageTools)).not.toContain('web_fetch');
    expect(Object.keys(proactiveMessageTools)).not.toContain('deep_research');
    expect(Object.keys(proactiveMessageTools)).toContain('web_search');
  });

  it("drops the session's disabledTools", () => {
    expect(Object.keys(proactiveMessageToolsFor({ disabledTools: ['web_search'] }))).not.toContain('web_search');
    expect(proactiveMessageToolsFor({})).toBe(proactiveMessageTools);
  });

  it('hands generateTools the filtered map rather than the whole registry', () => {
    expect(source).toMatch(/^\s+proactiveMessageToolsFor\(session\), \/\/ tools:/m);
    expect(source).not.toMatch(/^\s+b4mTools, \/\/ tools:/m);
  });

  // Optional on ToolContext.db, so dropping either typechecks and edit_image then refuses the
  // owner's own generated-image keys with only a logged warning.
  it('wires the generated-image owner lookup', () => {
    expect(source).toMatch(/quests: db\.quests,/);
    expect(source).toMatch(/sessions: \{ findAllByIds: db\.sessions\.findAllByIds\.bind\(db\.sessions\) \},/);
  });

  it('marks the turn as internal-origin', () => {
    expect(source).toMatch(/authOrigin: 'internal',/);
  });

  it('does not hand the tools the whole session repository', () => {
    // The whole repo would enable incrementImageCount for images no quest of this run holds.
    expect(source).not.toMatch(/sessions: db\.sessions,/);
  });

  it('leaves tool-internal calls on the raw backend', () => {
    expect(source).toMatch(/\n\s+backend,\n\s+\{ web_search:/);
  });
});

describe('generateAndSendProactiveMessage org model policy', () => {
  const tool = (name: string) => ({ toolSchema: { name }, toolFn: vi.fn() });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const db = {
    quests: { create: vi.fn() },
    sessions: { update: vi.fn(), findAllByIds: vi.fn() },
    sessionAgentConfigs: { updateLastProactiveMessageAt: vi.fn() },
    apiKeys: {},
    adminSettings: {},
    organizations: {},
  };
  const okMeter = vi.fn(async () => ({ refund: vi.fn(async () => undefined), settle: vi.fn(async () => 0) }));
  const run = (orgModelPolicy: ReadOrgModelPolicy, meter: typeof okMeter = okMeter) =>
    generateAndSendProactiveMessage({
      config: { proactiveMessaging: { enabled: true } },
      agent: { id: 'agent-1', name: 'Agent' },
      session: { id: 'session-1' },
      user: { id: 'user-1' },
      getEntitlements: async () => [],
      logger,
      db,
      apiKeyTable: {},
      storage: {},
      imageGenerateStorage: {},
      meter,
      orgModelPolicy,
    } as never);
  const offeredTools = () =>
    (h.complete.mock.calls[0][2].tools as Array<{ toolSchema: { name: string } }>).map(t => t.toolSchema.name);

  beforeEach(() => {
    vi.clearAllMocks();
    h.generateTools.mockReturnValue({ image_generation: tool('image_generation'), web_search: tool('web_search') });
    h.complete.mockImplementation(async (_model, _messages, _options, callback) => {
      await callback(['hello']);
    });
  });

  it('offers only the tools the org policy allows', async () => {
    await run({ allowedProviders: null, allowedModels: null, allowedTools: ['web_search'] });

    expect(offeredTools()).toEqual(['web_search']);
    expect(db.quests.create).toHaveBeenCalledOnce();
  });

  it('offers every built tool when the policy is unrestricted', async () => {
    await run(null);

    expect(offeredTools()).toEqual(['image_generation', 'web_search']);
  });

  it('hands the tools the governing policy but no organizationId', async () => {
    const policy: ReadOrgModelPolicy = { allowedProviders: null, allowedModels: ['claude'], allowedTools: null };
    await run(policy);

    const deps = vi.mocked(generateTools).mock.calls[0][3];
    expect(deps.governingOrgModelPolicy).toBe(policy);
    expect(deps).not.toHaveProperty('organizationId');
  });

  it('makes no provider call and posts nothing when the meter refuses the model', async () => {
    const refusing = vi.fn(async () => {
      throw new ForbiddenError('Model not allowed', { errorCode: ORG_MODEL_NOT_ALLOWED_ERROR_CODE });
    });

    await expect(
      run({ allowedProviders: null, allowedModels: [], allowedTools: null }, refusing as never)
    ).rejects.toThrow('Model not allowed');
    expect(h.complete).not.toHaveBeenCalled();
    expect(db.quests.create).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an unexpected failure as an error', async () => {
    h.complete.mockRejectedValueOnce(new Error('provider down'));

    await expect(run(null)).rejects.toThrow('provider down');
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('refuses a disallowed model inside a tool built from the same deps', async () => {
    const actual = await vi.importActual<typeof import('../llm/tools')>('../llm/tools');
    const admissions: Array<Promise<void>> = [];
    const probe = {
      ...b4mTools.dice_roll,
      implementation: (context: Parameters<typeof b4mTools.dice_roll.implementation>[0]) => ({
        ...b4mTools.dice_roll.implementation(context, undefined as never),
        toolFn: async () => {
          const admission = await createToolModelAdmission(context);
          admissions.push(admission.assert('claude-sonnet-4-6'), admission.assert('gpt-image-1'));
          return 'probed';
        },
      }),
    };
    h.generateTools.mockImplementationOnce((...args: Parameters<typeof generateTools>) => {
      args[13] = { dice_roll: probe } as never;
      return actual.generateTools(...args);
    });
    const findOrganization = vi.fn();
    const gateOff = { settingName: 'freeTierModelGateEnabled', settingValue: false };
    Object.assign(db, {
      adminSettings: {
        findOne: vi.fn(async () => null),
        findAll: vi.fn(async () => [gateOff]),
        findBySettingNames: vi.fn(async () => [gateOff]),
      },
      organizations: { findById: findOrganization },
    });

    await run({ allowedProviders: null, allowedModels: ['claude-sonnet-4-6'], allowedTools: null });
    const offered = h.complete.mock.calls[0][2].tools as Array<{ toolFn: (input: unknown) => Promise<unknown> }>;
    await offered[0].toolFn({});

    await expect(admissions[0]).resolves.toBeUndefined();
    await expect(admissions[1]).rejects.toThrow('not allowed by your organization');
    expect(findOrganization).not.toHaveBeenCalled();
  });
});

describe('buildProactiveMessageMessages', () => {
  const buildMessages = (recentMessages: IChatHistoryItem[]) =>
    buildProactiveMessageMessages({
      agent: { name: 'Assistant' } as IAgentDocument,
      config: { proactiveMessaging: {} } as ISessionAgentConfigDocument,
      session: {} as ISessionDocument,
      recentMessages,
    });

  it('omits an early-stopped prompt while preserving completed and partial turns', () => {
    const messages = buildMessages([
      { prompt: 'completed question', status: 'done', replies: ['completed answer'] },
      { prompt: 'cancelled question', status: 'stopped', replies: [] },
      { prompt: 'partial question', status: 'stopped', replies: ['partial answer'] },
    ] as IChatHistoryItem[]);

    expect(messages.slice(1, -1)).toEqual([
      { role: 'user', content: 'completed question' },
      { role: 'assistant', content: 'completed answer' },
      { role: 'user', content: 'partial question' },
      { role: 'assistant', content: 'partial answer' },
    ]);
  });

  it('keeps an error reply stored on a stopped turn', () => {
    const messages = buildMessages([
      { prompt: 'failed question', status: 'stopped', replies: ['Request failed'] },
    ] as IChatHistoryItem[]);

    expect(messages.slice(1, -1)).toEqual([
      { role: 'user', content: 'failed question' },
      { role: 'assistant', content: 'Request failed' },
    ]);
  });
});

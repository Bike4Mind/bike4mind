import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import mongooseDirect from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * End-to-end integration of the embed tool loop: REAL executeCompletion (built
 * @bike4mind/services dist), REAL buildSharedTools + KB tool implementations, REAL
 * executeToolsBatch, and REAL repositories on an in-memory Mongo. Only two seams are
 * faked, both third-party boundaries:
 *   - the LLM's reasoning: a scripted backend that "decides" which tool to call per
 *     test (running the real batch executor against the real materialized toolFns),
 *     then answers with `ANSWER:: <tool result>` so assertions inspect the actual
 *     bytes that flowed back through the loop;
 *   - the query embedding: EmbeddingFactory returns a fixed vector (cosine ranking
 *     itself stays real).
 * NOTE: the no-op tool callbacks are NOT the leak boundary here - KB confinement is
 * enforced inside the tools (kbScope); these tests prove that end to end.
 * Consumes the built dist: `pnpm turbo:core:build` must be current.
 */

vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
    log = vi.fn();
    updateMetadata = vi.fn();
  },
}));

const h = vi.hoisted(() => ({
  script: null as null | { toolName: string; args: Record<string, unknown> },
  lastBackendTools: [] as Array<{ toolSchema: { name: string } }>,
}));

vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  // executeToolsBatch is package-internal (not on the barrel); deep-import the source so
  // the scripted backend drives the REAL batch executor.
  const { executeToolsBatch } = await import('../../../../../b4m-core/llm-adapters/src/executeToolsBatch');
  const scriptedBackend = {
    currentModel: '',
    complete: async (
      _model: unknown,
      _messages: unknown,
      options: {
        tools?: Array<{ toolSchema: { name: string }; toolFn: (p: unknown) => Promise<unknown> }>;
        executeTools?: boolean;
      },
      onChunk: (text: string[], info?: Record<string, unknown>) => Promise<void>
    ) => {
      h.lastBackendTools = options.tools ?? [];
      if (!h.script) {
        await onChunk(['', 'plain answer'], { inputTokens: 40, outputTokens: 10 });
        return;
      }
      const tool = (options.tools ?? []).find(t => t.toolSchema.name === h.script!.toolName);
      let toolResult: string;
      if (!tool) {
        toolResult = `TOOL_UNAVAILABLE:${h.script!.toolName}`;
      } else if (options.executeTools === false) {
        toolResult = 'TOOLS_DISABLED';
      } else {
        // Turn 1: the REAL batch executor runs the REAL materialized toolFn.
        const [outcome] = await executeToolsBatch([() => tool.toolFn(h.script!.args)], { parallel: false });
        toolResult = outcome.ok
          ? String(outcome.result)
          : `TOOL_ERROR:${String((outcome as { error: unknown }).error)}`;
      }
      // Turn 2: answer quoting the tool result; terminal chunk carries the cumulative usage.
      await onChunk(['', `ANSWER:: ${toolResult}`], { inputTokens: 120, outputTokens: 40 });
    },
  };
  return {
    ...actual,
    getAvailableModels: vi.fn().mockResolvedValue([
      {
        id: 'test-model',
        backend: 'anthropic',
        type: 'text',
        pricing: { 200000: { input: 0.000003, output: 0.000015 } },
      },
    ]),
    getLlmByModel: vi.fn(() => scriptedBackend),
  };
});

const FIXED_VEC = [1, 0, 0, 0, 0, 0, 0, 0];
const ORTHOGONAL_VEC = [0, 1, 0, 0, 0, 0, 0, 0];

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    EmbeddingFactory: class {
      createEmbeddingService() {
        return { generateEmbedding: async () => FIXED_VEC };
      }
    },
    createTokenizer: () => ({ countTokens: async () => 4 }),
  };
});

const auth = vi.hoisted(() => ({
  info: {} as Record<string, unknown>,
}));
vi.mock('@server/cli/auth', () => ({
  verifyEmbedApiKey: vi.fn(async () => auth.info),
  verifyEmbedKeyById: vi.fn(async () => auth.info),
}));
vi.mock('@server/embed/embedSessionToken', () => ({ verifyEmbedSessionToken: vi.fn() }));
vi.mock('@server/utils/apiKeyRateLimitCheck', () => ({
  checkApiKeyRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('@server/utils/embedSessionRateLimit', () => ({
  checkEmbedSessionRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: vi.fn(() => ({})),
  getGeneratedImageStorage: vi.fn(() => ({})),
}));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://unused/%STAGE%', STAGE: 'test' } }));

// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../../packages/database/src/__test__/createMongoServer';
import { Organization, AdminSettings, Agent, Project, FabFile, FabFileChunk, UsageEvent } from '@bike4mind/database';
import { User } from '../../../../../packages/database/src/models/auth/UserModel';
import { registerEmbedRoutes } from './embedRoute';

let mongoServer: MongoMemoryServer;
let server: Server;
let baseUrl: string;

const evidence: Array<{ title: string; request: unknown; status: number; sseBody: string }> = [];

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongooseDirect.connect(mongoServer.getUri());

  const app = express();
  registerEmbedRoutes(app, () => {});
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}, 60000);

afterAll(async () => {
  server?.close();
  await mongooseDirect.disconnect();
  await mongoServer?.stop();
  if (process.env.B4M_EVIDENCE_OUT && evidence.length) {
    mkdirSync(process.env.B4M_EVIDENCE_OUT, { recursive: true });
    writeFileSync(join(process.env.B4M_EVIDENCE_OUT, 'cases.json'), JSON.stringify(evidence, null, 2));
  }
}, 30000);

afterEach(async () => {
  await mongooseDirect.connection.dropDatabase();
  h.script = null;
  h.lastBackendTools = [];
});

const IN_SCOPE_CONTENT = 'Widget pricing: the standard widget costs 42 gold pieces per unit.';
const OUT_OF_SCOPE_SECRET = 'SECRET-OUT-OF-SCOPE-DELTA: acquisition plans for next quarter.';
const CURATED_FOREIGN_CONTENT = 'Org handbook: curated by a teammate, shared into the agent project.';

interface SeedOverrides {
  agent?: Record<string, unknown>;
  skipProject?: boolean;
}

// Seeds the full object graph for one embed run and points the stubbed auth at it.
// Returns the ids the cases assert against.
async function seed(overrides: SeedOverrides = {}) {
  const owner = await User.create({ username: 'embed-owner', name: 'Embed Owner' });
  const org = await Organization.create({
    name: 'Embed Org',
    userId: owner.id,
    currentCredits: 100000,
    userDetails: [],
  });
  await User.updateOne({ _id: owner._id }, { organizationId: org.id });

  await AdminSettings.create([
    { settingName: 'defaultEmbeddingModel', settingValue: 'text-embedding-3-small' },
    { settingName: 'openaiDemoKey', settingValue: 'demo-openai-key' },
  ]);

  const inScopeA = await FabFile.create({
    userId: owner.id,
    fileName: 'widget-pricing.md',
    type: 'FILE',
    mimeType: 'text/markdown',
  });
  const outScope = await FabFile.create({
    userId: owner.id,
    fileName: 'acquisition-plans.md',
    type: 'FILE',
    mimeType: 'text/markdown',
  });
  const teammate = await User.create({ username: 'teammate', name: 'Teammate' });
  const curatedForeign = await FabFile.create({
    userId: teammate.id,
    fileName: 'org-handbook.md',
    type: 'FILE',
    mimeType: 'text/markdown',
  });

  await FabFileChunk.create([
    { fabFileId: inScopeA.id, text: IN_SCOPE_CONTENT, tokenCount: 16, vector: FIXED_VEC },
    { fabFileId: outScope.id, text: OUT_OF_SCOPE_SECRET, tokenCount: 12, vector: FIXED_VEC },
    { fabFileId: curatedForeign.id, text: CURATED_FOREIGN_CONTENT, tokenCount: 12, vector: ORTHOGONAL_VEC },
  ]);

  let projectId: string | undefined;
  if (!overrides.skipProject) {
    const project = await Project.create({
      name: 'Embed KB',
      description: 'agent knowledge set',
      userId: owner.id,
      sessionIds: [],
      // The curated-foreign file is owned by a DIFFERENT user: curation is the grant.
      fileIds: [inScopeA.id, curatedForeign.id],
    });
    projectId = project.id;
  }

  const agent = await Agent.create({
    name: 'Embed Agent',
    description: 'kb-scoped embed agent',
    organizationId: org.id,
    preferredModel: 'test-model',
    systemPrompt: 'You answer only from the knowledge base.',
    ...(projectId ? { projectId } : {}),
    ...(overrides.agent ?? {}),
  });

  auth.info = {
    keyId: 'key-1',
    userId: owner.id,
    scopes: ['embed:chat'],
    rateLimit: { requestsPerMinute: 10, requestsPerDay: 100 },
    billingOwnerType: 'Organization',
    organizationId: org.id,
    agentId: agent.id,
    allowedOrigins: ['https://example.com'],
  };

  return { owner, org, agent, inScopeA, outScope, curatedForeign };
}

async function post(title: string, body: unknown = { messages: [{ role: 'user', content: 'hi' }] }) {
  const res = await fetch(`${baseUrl}/api/embed/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'b4m_live_embed' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  evidence.push({ title, request: { body, script: h.script }, status: res.status, sseBody: text });
  return { res, text };
}

describe('embed tool loop (real executeCompletion + real KB tools + real Mongo)', () => {
  beforeEach(() => {
    h.script = null;
  });

  it('answers a KB search from in-scope content only - the same-owner out-of-scope file never leaks', async () => {
    await seed();
    h.script = { toolName: 'search_knowledge_base', args: { query: 'widget pricing' } };

    const { res, text } = await post('scoped KB search answers from project files only');

    expect(res.status).toBe(200);
    expect(text).toContain('ANSWER::');
    expect(text).toContain('42 gold pieces');
    expect(text).not.toContain('SECRET-OUT-OF-SCOPE-DELTA');
    expect(text).toContain('[DONE]');
  }, 30000);

  it('rejects retrieve_knowledge_content for an out-of-scope file id owned by the SAME user', async () => {
    const { outScope } = await seed();
    h.script = { toolName: 'retrieve_knowledge_content', args: { file_id: outScope.id } };

    const { text } = await post('out-of-scope file_id reads as not-found');

    expect(text).toContain('No document found with ID');
    expect(text).not.toContain('SECRET-OUT-OF-SCOPE-DELTA');
  }, 30000);

  it('serves a file curated into the project even when owned by another user (curation is the grant)', async () => {
    const { curatedForeign } = await seed();
    h.script = { toolName: 'retrieve_knowledge_content', args: { file_id: curatedForeign.id } };

    const { text } = await post('curated not-owned file is readable');

    expect(text).toContain('curated by a teammate');
  }, 30000);

  it('a denied KB tool never reaches the backend tool list', async () => {
    await seed({ agent: { deniedTools: ['search_knowledge_base'] } });
    h.script = { toolName: 'search_knowledge_base', args: { query: 'widget pricing' } };

    const { text } = await post('denied tool is absent from the materialized set');

    const names = h.lastBackendTools.map(t => t.toolSchema.name);
    expect(names).not.toContain('search_knowledge_base');
    expect(names).toContain('retrieve_knowledge_content');
    expect(text).toContain('TOOL_UNAVAILABLE:search_knowledge_base');
    expect(text).not.toContain('42 gold pieces');
  }, 30000);

  it('an opted-in curated tool is materialized and executable alongside the KB defaults', async () => {
    await seed({ agent: { allowedTools: ['current_datetime'] } });
    h.script = { toolName: 'current_datetime', args: {} };

    const { text } = await post('opted-in current_datetime executes');

    const names = h.lastBackendTools.map(t => t.toolSchema.name);
    expect(names).toEqual(
      expect.arrayContaining(['search_knowledge_base', 'retrieve_knowledge_content', 'current_datetime'])
    );
    expect(text).toContain('ANSWER::');
    expect(text).not.toContain('TOOL_UNAVAILABLE');
  }, 30000);

  it('an agent with no project gets an empty KB: search returns nothing, never the owner corpus', async () => {
    await seed({ skipProject: true });
    h.script = { toolName: 'search_knowledge_base', args: { query: 'widget pricing' } };

    const { text } = await post('no projectId => empty KB');

    expect(text).toContain('No documents found');
    expect(text).not.toContain('42 gold pieces');
    expect(text).not.toContain('SECRET-OUT-OF-SCOPE-DELTA');
  }, 30000);

  it('meters the multi-turn tool run against the owner org', async () => {
    const { org, owner } = await seed();
    h.script = { toolName: 'search_knowledge_base', args: { query: 'widget pricing' } };

    await post('usage metered to the org across the tool loop');

    const events = await UsageEvent.find({ feature: 'completion_api' }).lean();
    expect(events).toHaveLength(1);
    expect(String(events[0].ownerId)).toBe(org.id);
    expect(events[0].ownerType).toBe('Organization');
    expect(String(events[0].userId)).toBe(owner.id);
    expect(events[0].inputTokens).toBe(120);
    expect(events[0].outputTokens).toBe(40);
  }, 30000);
});

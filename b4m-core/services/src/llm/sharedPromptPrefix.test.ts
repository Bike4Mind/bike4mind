/**
 * The shareable prefix (SHAREABLE_PREFIX_SOURCES) only saves anything if two DIFFERENT callers send
 * byte-identical bytes up to its breakpoint: Anthropic's cache hashes tools, then system, as a
 * prefix. This builds the real outbound Anthropic request for two users who differ in everything a
 * default in-app turn can vary by - timezone and date, admin role, current page, conversation
 * entities, saved tool order, their own context - and pins that the head is shared.
 *
 * Companion to promptCacheStability.test.ts, which pins the same identity turn over turn for ONE
 * caller; this one pins it across callers.
 */
import { describe, expect, it, vi } from 'vitest';
import { ChatModels, getViewSummaryForLLM, type ICacheStrategy, type IMessage } from '@bike4mind/common';
import { AnthropicBackend, type ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { getConversationContextSystemMessage } from '../conversationContextService';
import { ToolBuilder, type ToolBuilderConfig } from './tools/ToolBuilder';
import { buildViewRegistryAdminMessages } from './viewRegistryPrompt';
import { buildTaggedContextMessages, markShareablePrefixBoundary } from './systemPromptSources';

vi.mock('../conversationContextService', () => ({
  extractAndSaveEntitiesFromUserMessage: vi.fn(),
  getConversationContextSystemMessage: vi.fn(),
}));

const logger = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };
const sys = (content: string): IMessage => ({ role: 'system', content });

const tool = (name: string): ICompletionOptionTools => ({
  toolSchema: { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } },
  toolFn: async () => 'ok',
});

type Block = Record<string, unknown>;
type Request = { tools?: Block[]; system?: Block[] };

type Caller = {
  timezone: string;
  date: string;
  isAdmin: boolean;
  currentPath: string;
  conversationEntities: string;
  /** Same tool set, in the order this caller's client happened to save it. */
  toolOrder: string[];
  memento: string;
};

const TOKYO_ADMIN: Caller = {
  timezone: 'Asia/Tokyo',
  date: 'Current date: Thursday, October 22, 2026',
  isAdmin: true,
  currentPath: '/admin',
  conversationEntities: 'The referenced PR is example/repo#1.',
  toolOrder: ['web_search', 'current_datetime', 'navigate_view'],
  memento: 'User prefers metric units.',
};

const DENVER_MEMBER: Caller = {
  timezone: 'America/Denver',
  date: 'Current date: Wednesday, October 21, 2026',
  isAdmin: false,
  currentPath: '/',
  conversationEntities: 'The referenced issue is example/repo#2.',
  toolOrder: ['navigate_view', 'current_datetime', 'web_search'],
  memento: 'User is a cyclist.',
};

async function sendFirstTurn(caller: Caller): Promise<Request> {
  vi.mocked(getConversationContextSystemMessage).mockResolvedValue(sys(caller.conversationEntities) as never);
  const toolPrompt = await new ToolBuilder({
    user: { id: caller.timezone },
    db: { sessions: {} },
    logger,
  } as unknown as ToolBuilderConfig).buildToolPrompt({
    hasContentTransform: false,
    hasChessEngine: false,
    hasCurrentDateTime: true,
    hasWebSearch: true,
    webSearchGuidance: 'web search guidance',
    hasKnowledgeBase: false,
    userTimezone: caller.timezone,
    mcpTools: [],
    sessionId: `session-${caller.timezone}`,
    message: 'hello',
    logger: logger as never,
    processStartTime: Date.now(),
    extraContextMessages: [],
  });
  const extraContext = [sys(`[Current View Context]\nPath: ${caller.currentPath}`)];

  // Shaped like ChatCompletionProcess.process() on a default first turn with navigate_view offered.
  const tagged = buildTaggedContextMessages({
    dateContext: [sys(caller.date)],
    extraContext,
    artifactEmission: [sys('artifact guidance')],
    helpCenter: [sys('help center guidance')],
    abstention: [sys('abstention guidance')],
    viewRegistry: [sys(getViewSummaryForLLM({ isAdmin: false }))],
    viewRegistryAdmin: buildViewRegistryAdminMessages({ isAdmin: caller.isAdmin, extraContextMessages: extraContext }),
    replyChoices: [sys('reply choices guidance')],
    toolPrompt: toolPrompt.guidance ? [toolPrompt.guidance] : [],
    toolContext: toolPrompt.context ? [toolPrompt.context] : [],
    mementos: [sys(caller.memento)],
  });
  markShareablePrefixBoundary(tagged);

  const cacheStrategy: ICacheStrategy = {
    enableCaching: true,
    cacheSystemPrompt: true,
    cacheTools: true,
    cacheConversationHistory: true,
    cacheTTL: '5m',
  };
  const backend = new AnthropicBackend('test-key');
  let request: Request | undefined;
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (params: Request) => {
        request = params;
        return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  await backend.complete(
    ChatModels.CLAUDE_4_8_OPUS,
    [...tagged.map(t => t.message), { role: 'user', content: 'hello' }],
    { stream: false, tools: caller.toolOrder.map(tool), cacheStrategy },
    async () => {}
  );
  return request!;
}

/** The first system block carrying a breakpoint: the end of the shareable run. */
const shareableBreakpoint = (request: Request) => (request.system ?? []).findIndex(block => block.cache_control);

const sharedHead = (request: Request) =>
  JSON.stringify({ tools: request.tools, system: request.system?.slice(0, shareableBreakpoint(request) + 1) });

describe('shareable prompt prefix across callers', () => {
  it('sends byte-identical tools and system up to the shareable breakpoint for two different users', async () => {
    const tokyo = await sendFirstTurn(TOKYO_ADMIN);
    const denver = await sendFirstTurn(DENVER_MEMBER);

    expect(shareableBreakpoint(tokyo)).toBeGreaterThan(0);
    expect(sharedHead(tokyo)).toBe(sharedHead(denver));

    // Control: the two requests really do differ behind the breakpoint, so the identity above is
    // not vacuous - each per-caller value reached the request, just not the shared head.
    const tail = (request: Request) => JSON.stringify(request.system?.slice(shareableBreakpoint(request) + 1));
    for (const perCaller of [
      TOKYO_ADMIN.date,
      TOKYO_ADMIN.timezone,
      TOKYO_ADMIN.conversationEntities,
      TOKYO_ADMIN.memento,
      'Admin views for navigate_view',
      'currently on the Admin page',
    ]) {
      expect(tail(tokyo)).toContain(perCaller);
      expect(sharedHead(tokyo)).not.toContain(perCaller);
    }
    expect(tail(denver)).toContain(DENVER_MEMBER.timezone);
  });
});

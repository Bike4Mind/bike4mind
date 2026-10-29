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
import { createHash } from 'node:crypto';
import type { HistoryToolTurn } from '@bike4mind/utils';
import {
  applyToolTimeline,
  declareDeferredTools,
  hasCoreTool,
  planToolTimeline,
  type ToolTimeline,
} from './deferredToolLoading';
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
type Request = { tools?: Block[]; system?: Block[]; messages?: Block[]; betaHeader?: string };

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

/** A replayed turn: its prompt, reply, and the tools that turn offered. */
type PastTurn = { prompt: string; reply: string; offered: string[] };

/** Whether deferred tool loading is on for the turn (as ChatCompletionProcess decides it), and the history. */
type SendOptions = { deferTools?: boolean; history?: PastTurn[]; prompt?: string };

async function sendTurn(
  caller: Caller,
  { deferTools = false, history = [], prompt = 'hello' }: SendOptions = {}
): Promise<Request> {
  vi.mocked(getConversationContextSystemMessage).mockResolvedValue(sys(caller.conversationEntities) as never);
  const offered = caller.toolOrder;
  const historyMessages: IMessage[] = [];
  const toolTurns: HistoryToolTurn[] = [];
  for (const past of history) {
    const promptMessage: IMessage = { role: 'user', content: past.prompt };
    historyMessages.push(promptMessage, { role: 'assistant', content: past.reply });
    toolTurns.push({ prompt: promptMessage, offeredTools: past.offered, calledTools: [] });
  }
  const timeline: ToolTimeline | null =
    deferTools && hasCoreTool(offered) ? planToolTimeline(toolTurns, offered) : null;
  const guided = new Set(timeline?.everAdded ?? []);
  const toolPrompt = await new ToolBuilder({
    user: { id: caller.timezone },
    db: { sessions: {} },
    logger,
  } as unknown as ToolBuilderConfig).buildToolPrompt({
    hasContentTransform: false,
    hasChessEngine: false,
    hasCurrentDateTime: offered.includes('current_datetime') || guided.has('current_datetime'),
    hasWebSearch: offered.includes('web_search') || guided.has('web_search'),
    webSearchGuidance: 'web search guidance',
    hasKnowledgeBase: offered.includes('search_knowledge_base') || guided.has('search_knowledge_base'),
    knowledgeBaseGuidance: 'knowledge base guidance',
    deferGuidanceFor: guided,
    userTimezone: caller.timezone,
    mcpTools: [],
    sessionId: `session-${caller.timezone}`,
    message: 'hello',
    logger: logger as never,
    processStartTime: Date.now(),
    extraContextMessages: [],
  });
  const extraContext = [sys(`[Current View Context]\nPath: ${caller.currentPath}`)];

  // Shaped like ChatCompletionProcess.process() on a default first turn.
  const navigateView = offered.includes('navigate_view');
  const tagged = buildTaggedContextMessages({
    dateContext: [sys(caller.date)],
    extraContext,
    artifactEmission: [sys('artifact guidance')],
    helpCenter: [sys('help center guidance')],
    abstention: [sys('abstention guidance')],
    viewRegistry: navigateView && !guided.has('navigate_view') ? [sys(getViewSummaryForLLM({ isAdmin: false }))] : [],
    viewRegistryAdmin: navigateView
      ? buildViewRegistryAdminMessages({ isAdmin: caller.isAdmin, extraContextMessages: extraContext })
      : [],
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
  const baseMessages: IMessage[] = [
    ...tagged.map(t => t.message),
    ...historyMessages,
    { role: 'user', content: prompt },
  ];
  const guidance = new Map(toolPrompt.deferredGuidance.map(entry => [entry.tool, entry.text]));
  if (guided.has('navigate_view')) guidance.set('navigate_view', getViewSummaryForLLM({ isAdmin: false }));
  const tools = timeline ? declareDeferredTools(offered.map(tool), timeline.notOffered.map(tool)) : offered.map(tool);
  const messages = timeline ? applyToolTimeline(baseMessages, timeline.changes, guidance) : baseMessages;

  const backend = new AnthropicBackend('test-key');
  let request: Request | undefined;
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (params: Request, requestOptions?: { headers?: Record<string, string> }) => {
        request = { ...params, betaHeader: requestOptions?.headers?.['anthropic-beta'] };
        return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  await backend.complete(ChatModels.CLAUDE_4_8_OPUS, messages, { stream: false, tools, cacheStrategy }, async () => {});
  return request!;
}

/** The first system block carrying a breakpoint: the end of the shareable run. */
const shareableBreakpoint = (request: Request) => (request.system ?? []).findIndex(block => block.cache_control);

const sharedHead = (request: Request) =>
  JSON.stringify({ tools: request.tools, system: request.system?.slice(0, shareableBreakpoint(request) + 1) });

describe('shareable prompt prefix across callers', () => {
  it('sends byte-identical tools and system up to the shareable breakpoint for two different users', async () => {
    const tokyo = await sendTurn(TOKYO_ADMIN);
    const denver = await sendTurn(DENVER_MEMBER);

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

// The part of the request the API renders ahead of the shareable breakpoint: deferred definitions
// are left out of the rendered prefix (tool search docs), but measured live, whether any deferred
// tool is declared at all does change it.
const renderedHeadHash = (request: Request) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        tools: request.tools?.filter(block => block.defer_loading !== true),
        anyDeferred: request.tools?.some(block => block.defer_loading === true) ?? false,
        system: request.system?.slice(0, shareableBreakpoint(request) + 1),
      })
    )
    .digest('hex');

// The adapter turns a string into a text block to carry a breakpoint; both render the same tokens.
const withoutCacheControl = (value: unknown) =>
  JSON.stringify(value, (key, inner) =>
    key === 'cache_control'
      ? undefined
      : key === 'content' && typeof inner === 'string'
        ? [{ type: 'text', text: inner }]
        : inner
  );

describe('shareable prompt prefix with deferred tool loading', () => {
  const WEB_USER: Caller = {
    ...TOKYO_ADMIN,
    toolOrder: ['current_model_details', 'web_search', 'current_datetime', 'navigate_view'],
  };
  const KNOWLEDGE_USER: Caller = {
    ...DENVER_MEMBER,
    toolOrder: ['search_knowledge_base', 'current_model_details', 'retrieve_knowledge_content'],
  };

  it('hashes the rendered head the same for users with different optional tools', async () => {
    const web = await sendTurn(WEB_USER, { deferTools: true });
    const knowledge = await sendTurn(KNOWLEDGE_USER, { deferTools: true });

    expect(renderedHeadHash(web)).toBe(renderedHeadHash(knowledge));
    expect(web.tools?.filter(block => block.defer_loading !== true).map(block => block.name)).toEqual([
      'current_model_details',
    ]);
  });

  it('declares only the caller own tools and adds them, with their guidance, in the messages', async () => {
    const web = await sendTurn(WEB_USER, { deferTools: true });

    expect(web.tools?.filter(block => block.defer_loading === true).map(block => block.name)).toEqual([
      'current_datetime',
      'deferred_tools_anchor',
      'navigate_view',
      'web_search',
    ]);
    expect(JSON.stringify(web.tools)).not.toContain('search_knowledge_base');
    const change = web.messages?.find(message => message.role === 'system');
    expect(change?.content).toEqual(
      expect.arrayContaining([
        { type: 'tool_addition', tool: { type: 'tool_reference', name: 'web_search' } },
        expect.objectContaining({ type: 'text', text: expect.stringContaining('web search guidance') }),
      ])
    );
    expect(JSON.stringify(change)).toContain('CURRENT TIME');
    expect(JSON.stringify(web.system)).not.toContain('web search guidance');
    expect(web.betaHeader).toContain('mid-conversation-tool-changes-2026-07-01');
  });

  it('gives a turn with no optional tools the same head, through the always-declared anchor', async () => {
    const web = await sendTurn(WEB_USER, { deferTools: true });
    const coreOnly = await sendTurn({ ...DENVER_MEMBER, toolOrder: ['current_model_details'] }, { deferTools: true });

    expect(renderedHeadHash(coreOnly)).toBe(renderedHeadHash(web));
    expect(coreOnly.messages?.some(message => message.role === 'system')).toBe(false);
  });

  it('appends a mid-session addition after the new turn and leaves the earlier messages as sent', async () => {
    const turn1Tools = ['current_model_details', 'web_search'];
    const first = await sendTurn({ ...WEB_USER, toolOrder: turn1Tools }, { deferTools: true, prompt: 'u1' });
    const second = await sendTurn(
      { ...WEB_USER, toolOrder: [...turn1Tools, 'current_datetime'] },
      { deferTools: true, history: [{ prompt: 'u1', reply: 'a1', offered: turn1Tools }], prompt: 'u2' }
    );

    expect(renderedHeadHash(second)).toBe(renderedHeadHash(first));
    expect(withoutCacheControl(second.messages?.slice(0, first.messages!.length))).toBe(
      withoutCacheControl(first.messages)
    );
    expect(second.messages?.at(-1)?.content).toEqual(
      expect.arrayContaining([{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'current_datetime' } }])
    );
    expect(JSON.stringify(second.messages?.at(-1))).toContain('CURRENT TIME');
  });

  it('removes a tool no longer offered after the new turn and keeps it declared for the history', async () => {
    const turn1Tools = ['current_model_details', 'web_search'];
    const first = await sendTurn({ ...WEB_USER, toolOrder: turn1Tools }, { deferTools: true, prompt: 'u1' });
    const second = await sendTurn(
      { ...WEB_USER, toolOrder: ['current_model_details'] },
      { deferTools: true, history: [{ prompt: 'u1', reply: 'a1', offered: turn1Tools }], prompt: 'u2' }
    );

    expect(renderedHeadHash(second)).toBe(renderedHeadHash(first));
    expect(withoutCacheControl(second.messages?.slice(0, first.messages!.length))).toBe(
      withoutCacheControl(first.messages)
    );
    expect(second.messages?.at(-1)?.content).toEqual([
      { type: 'tool_removal', tool: { type: 'tool_reference', name: 'web_search' } },
    ]);
    expect(second.tools?.find(block => block.name === 'web_search')?.defer_loading).toBe(true);
  });

  it('control: with deferral off the same two users get different heads', async () => {
    const web = await sendTurn(WEB_USER);
    const knowledge = await sendTurn(KNOWLEDGE_USER);

    expect(renderedHeadHash(web)).not.toBe(renderedHeadHash(knowledge));
    expect(web.messages?.some(message => message.role === 'system')).toBe(false);
  });
});

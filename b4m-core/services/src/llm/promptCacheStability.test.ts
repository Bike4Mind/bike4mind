/**
 * Anthropic's prompt cache matches on a prefix, in the order tools, system, messages. A turn reads
 * what the previous turn wrote only if the request's prefix up to the previous turn's history
 * breakpoint is byte-identical. This builds the real outbound Anthropic request for consecutive turns
 * of a long session - real history window, real message builder, real session-sticky tool set, real
 * caching adapter - and pins that identity, turn over turn.
 *
 * Deliberately short of ChatCompletionProcess.process(): that is covered by its own wiring tests in
 * ChatCompletion.test.ts. The pieces assembled here are the ones that decide the prefix.
 */
import { describe, expect, it, vi } from 'vitest';
import { ChatModels, type ICacheStrategy, type IMessage, type ISessionDocument } from '@bike4mind/common';
import { AnthropicBackend, type ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { buildAndSortMessages, fetchAndProcessPreviousMessages, HISTORY_WINDOW_STEP } from '@bike4mind/utils';
import { resolveStickyAutoAddedTools, shouldOfferBlogTools } from './autoAddedToolGating';
import { resolveModelAwareHistoryCount } from './ChatCompletionProcess';
import {
  buildTaggedContextMessages,
  filterByPromptMode,
  markShareablePrefixBoundary,
  SYSTEM_PROMPT_PRIORITY,
} from './systemPromptSources';

const LIMIT = resolveModelAwareHistoryCount({ historyCount: 30, contextWindow: 200_000 });
const FIRST_TURN = 56;
const LAST_TURN = 76;
const TOOL_TURN = 64;

const sys = (content: string): IMessage => ({ role: 'system', content });

const logger = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };
const tokenizer = {
  countTokens: async (text: string) => Math.ceil(text.length / 4),
  encodeTokens: async (text: string) => Array(Math.ceil(text.length / 4)).fill(1),
  clearCache: () => {},
  getCacheStats: () => ({ size: 0, keys: [] }),
  warmUpCache: async () => {},
};

// Alternating a bare query and a long analytical one: neither may move the history window or the prefix.
// The only turn with a trigger is the blog request; the tool must outlive it.
const messageFor = (priorQuestCount: number) =>
  priorQuestCount === TOOL_TURN
    ? 'Turn this into a blog post'
    : priorQuestCount % 2 === 0
      ? 'thanks'
      : `Compare the trade-offs of approach ${priorQuestCount} against the alternatives we discussed, step by step, and recommend one.`;

// The in-flight quest (n = priorQuestCount + 1) carries the message being sent, as it does in a real
// session, so what a turn sent last time is what the next turn's history replays.
const makeQuest = (n: number) => ({
  id: String(n).padStart(24, '0'),
  sessionId: 'session1',
  prompt: messageFor(n - 1),
  reply: `answer ${n}`,
  replies: [`answer ${n}`],
  timestamp: new Date(n * 1000),
  type: 'message',
  status: 'done',
});

/** `priorQuestCount` finished quests plus the in-flight one, newest first as the repository returns them. */
const repository = (priorQuestCount: number) => {
  const all = Array.from({ length: priorQuestCount + 1 }, (_, i) => makeQuest(i + 1));
  return {
    getMostRecentChatHistory: async (_sessionId: string, limit: number) => all.slice(-limit).reverse(),
    countBySessionId: async () => all.length,
  };
};

const tool = (name: string): ICompletionOptionTools => ({
  toolSchema: { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } },
  toolFn: async () => 'ok',
});
const BASE_TOOLS = ['web_search', 'current_datetime'];

type Block = Record<string, unknown>;
type Request = {
  tools?: Block[];
  system?: Block[];
  messages: Array<{ role: string; content: string | Block[] }>;
};

/**
 * What the cache keys on is the rendered prompt, not the JSON: a breakpoint turns a message's string
 * content into a one-block array, which renders identically. Canonicalize that, and drop the markers.
 */
const canonical = (request: Request, messageCount: number) =>
  JSON.stringify(
    { tools: request.tools, system: request.system, messages: request.messages.slice(0, messageCount) },
    (key, value) => (key === 'cache_control' ? undefined : value)
  );

const normalizeContent = (request: Request): Request => ({
  ...request,
  messages: request.messages.map(m => ({
    ...m,
    content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content,
  })),
});

const hasMarker = (content: string | Block[]): boolean => Array.isArray(content) && content.some(b => b.cache_control);

interface Turn {
  request: Request;
  /** Turns the token budget pushed out of the window (0 when the count window alone decided it). */
  excluded: number;
  /** Index of the last message carrying a cache breakpoint: the history anchor. */
  anchor: number;
  toolNames: string[];
  windowStart: number;
}

/** Everything a session carries between turns that the next turn reads back. */
interface SessionState {
  persistedTools: string[];
}

async function runTurn(priorQuestCount: number, state: SessionState, verbatimTokenBudget?: number): Promise<Turn> {
  const session = { id: 'session1' } as unknown as ISessionDocument;
  const [history, , meta] = await fetchAndProcessPreviousMessages(session, LIMIT, {
    db: { quests: repository(priorQuestCount) },
    verbatimTokenBudget,
  });
  const windowStart = Number(meta.oldestIncludedQuestId);

  const message = messageFor(priorQuestCount);
  const blog = shouldOfferBlogTools({ isAdmin: true, hasBlogIntegration: false, message, priorToolNames: [] });
  const sticky = await resolveStickyAutoAddedTools({
    persisted: state.persistedTools,
    triggered: blog.draft ? ['blog_draft'] : [],
    eligibility: {
      isAdmin: true,
      hasBlogIntegration: false,
      hasSkillRepository: false,
      dataLakesEnabled: async () => false,
    },
  });
  state.persistedTools = [...new Set([...state.persistedTools, ...sticky.newlyTriggered])];
  const toolNames = [...BASE_TOOLS, ...sticky.tools];

  // A stack shaped like process(), with session-stable sources only: a source in system whose text
  // changes per turn moves the prefix whatever the window and the tool set do.
  const tagged = buildTaggedContextMessages({
    dateContext: [sys('Current date: Tuesday, October 20, 2026')],
    artifactEmission: [sys('artifact guidance')],
    helpCenter: [sys('help center guidance')],
    abstention: [sys('abstention guidance')],
    toolPrompt: [sys('tool guidance')],
    extraContext: [sys('[ADMIN_PROMPT:bike4mind_identity]\nYou are the assistant.')],
    sessionPrompt: [sys('session prompt')],
    contextSummary: [sys('[Context from earlier in this conversation]\nrunning summary')],
  });
  const admitted = filterByPromptMode(tagged, undefined);
  markShareablePrefixBoundary(admitted);
  const priorities = new Map(admitted.map(t => [t.message, SYSTEM_PROMPT_PRIORITY[t.source]]));
  const prompt: IMessage[] = [{ role: 'user', content: message }];

  const built = await buildAndSortMessages(
    history,
    admitted.map(t => t.message),
    prompt,
    150_000,
    {},
    LIMIT,
    logger as never,
    tokenizer as never,
    { verbose: false, skipAdminPromptTemplates: true, systemMessagePriority: m => priorities.get(m) }
  );
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
    built.messages,
    { stream: false, tools: toolNames.map(tool), cacheStrategy },
    async () => {}
  );

  const sent = request!;
  const anchor = sent.messages.map(m => hasMarker(m.content)).lastIndexOf(true);
  return { request: sent, anchor, toolNames, windowStart, excluded: meta.excludedOlderQuestCount ?? 0 };
}

/** The request's prefix up to and including a message index, as the cache would hash it. */
const prefixThrough = (request: Request, messageIndex: number) =>
  canonical(normalizeContent(request), messageIndex + 1);

async function runSession(verbatimTokenBudget?: number): Promise<Turn[]> {
  const state: SessionState = { persistedTools: [] };
  const turns: Turn[] = [];
  for (let prior = FIRST_TURN; prior <= LAST_TURN; prior++)
    turns.push(await runTurn(prior, state, verbatimTokenBudget));
  return turns;
}

/** Turns at which the next request failed to reuse the previous one's prefix, keyed to the turn that breaks it. */
function turnsThatBustThePrefix(turns: Turn[]): number[] {
  const busted: number[] = [];
  for (let i = 0; i + 1 < turns.length; i++) {
    const [current, next] = [turns[i], turns[i + 1]];
    const reused = prefixThrough(next.request, current.anchor) === prefixThrough(current.request, current.anchor);
    const windowStepped = next.windowStart !== current.windowStart;
    const toolsGrew = next.toolNames.length > current.toolNames.length;
    if (windowStepped || toolsGrew) {
      // Control: the exceptions really do change the prefix, so the identity checks below are not vacuous.
      expect(reused, `turn ${FIRST_TURN + i + 1} should not reuse the prefix`).toBe(false);
      busted.push(FIRST_TURN + i + 1);
    } else {
      expect(reused, `turn ${FIRST_TURN + i + 1} should reuse the prefix`).toBe(true);
    }
  }
  return busted;
}

describe('prompt-cache prefix stability across turns of a long session', () => {
  it('starts past the history limit and crosses two step boundaries', async () => {
    const turns = await runSession();
    const starts = new Set(turns.map(t => t.windowStart));

    expect(FIRST_TURN).toBeGreaterThan(LIMIT);
    expect(starts.size).toBe(3);
    expect(HISTORY_WINDOW_STEP).toBe(10);
  });

  it("reuses turn N's prefix, up to its history breakpoint, in turn N+1 - except where the window steps or a tool first appears", async () => {
    const turns = await runSession();

    // The two window steps (T = 61 and 71) and the turn the blog tool first appears.
    expect(turnsThatBustThePrefix(turns)).toEqual([61, TOOL_TURN, 71]);
  });

  // Production passes a verbatim token budget on every turn, sized from that turn's message and tool
  // list - so once the budget binds, it, not the quest count, picks the window start, and a trim that
  // did not round would slide it every turn. The long sessions the window exists for are exactly the
  // ones where it binds.
  describe('with a token budget that binds', () => {
    const BUDGET = 300;

    it('starts every window on the same step grid as the count window, and busts the prefix only there', async () => {
      const turns = await runSession(BUDGET);

      // Guard: the budget really binds, so some of these starts come from the trim, not the count window.
      expect(turns.filter(turn => turn.excluded > 0).length).toBeGreaterThan(0);
      for (const turn of turns) expect((turn.windowStart - 1) % HISTORY_WINDOW_STEP).toBe(0);

      // Only the window step and the turn the blog tool first appears - a budget that moved the start
      // on its own would show up here as a bust on almost every turn.
      expect(turnsThatBustThePrefix(turns)).toEqual([TOOL_TURN, 74]);
    });
  });

  it('keeps the blog tool on every turn after the one that triggered it', async () => {
    const turns = await runSession();

    for (let i = 0; i < turns.length; i++) {
      const prior = FIRST_TURN + i;
      expect(turns[i].toolNames.includes('blog_draft')).toBe(prior >= TOOL_TURN);
    }
  });

  it('never exceeds the four cache breakpoints a request may carry', async () => {
    const turns = await runSession();

    for (const { request } of turns) {
      const markers =
        (request.tools ?? []).filter(b => b.cache_control).length +
        (request.system ?? []).filter(b => b.cache_control).length +
        request.messages.filter(m => hasMarker(m.content)).length;
      expect(markers).toBeLessThanOrEqual(4);
    }
  });
});

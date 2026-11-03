import { describe, expect, it } from 'vitest';
import type { IMessage } from '@bike4mind/common';
import { stripToolDependentMessages, type ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { DEFERRED_ANCHOR_TOOL_NAME } from '@bike4mind/common';
import type { HistoryToolTurn } from '@bike4mind/utils';
import {
  applyToolTimeline,
  declareDeferredTools,
  DEFERRED_TOOLS_MARKER,
  estimateToolDefinitionTokens,
  hasCoreTool,
  lookbackAnchor,
  planToolTimeline,
  startToolNames,
  undoDeferredTools,
} from './deferredToolLoading';

const CORE = 'current_model_details';

const tool = (name: string): ICompletionOptionTools => ({
  toolSchema: { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } },
  toolFn: async () => 'ok',
});
const names = (tools: ICompletionOptionTools[] | undefined) => tools?.map(t => t.toolSchema.name);
const deferredNames = (tools: ICompletionOptionTools[]) =>
  tools.filter(t => t.toolSchema.defer_loading).map(t => t.toolSchema.name);

const user = (content: string): IMessage => ({ role: 'user', content });
const assistant = (content: string): IMessage => ({ role: 'assistant', content });
const sys = (content: string): IMessage => ({ role: 'system', content });

const turn = (prompt: IMessage, offeredTools?: string[], calledTools: string[] = []): HistoryToolTurn => ({
  prompt,
  offeredTools,
  calledTools,
});
const change = (added: string[], removed: string[] = [], text?: string): IMessage => ({
  role: 'system',
  requiresTool: DEFERRED_TOOLS_MARKER,
  content: [
    ...removed.map(name => ({ type: 'tool_removal', tool: { type: 'tool_reference', name } })),
    ...added.map(name => ({ type: 'tool_addition', tool: { type: 'tool_reference', name } })),
    ...(text ? [{ type: 'text', text }] : []),
  ] as unknown as IMessage['content'],
});

describe('hasCoreTool', () => {
  it('needs a core tool, since the API needs one loaded tool', () => {
    expect(hasCoreTool(['web_search', CORE])).toBe(true);
    expect(hasCoreTool(['web_search', 'navigate_view'])).toBe(false);
  });
});

describe('planToolTimeline', () => {
  const u1 = user('u1');
  const u2 = user('u2');

  it('adds the optional tools after the turn that first offered them, sorted, without the core tool', () => {
    const timeline = planToolTimeline(
      [turn(u1, [CORE, 'web_search', 'navigate_view'])],
      [CORE, 'web_search', 'navigate_view']
    );
    expect(timeline).toEqual({
      changes: [{ after: u1, added: ['navigate_view', 'web_search'], removed: [] }],
      everAdded: ['navigate_view', 'web_search'],
      loaded: new Set(),
      notOffered: [],
    });
  });

  it('appends an addition for a tool first offered now and keeps earlier changes as they were', () => {
    const timeline = planToolTimeline([turn(u1, [CORE, 'web_search'])], [CORE, 'web_search', 'current_datetime']);
    expect(timeline.changes).toEqual([
      { after: u1, added: ['web_search'], removed: [] },
      { after: null, added: ['current_datetime'], removed: [] },
    ]);
  });

  it('removes a tool no longer offered and lists it as declared-only', () => {
    const timeline = planToolTimeline(
      [turn(u1, [CORE, 'web_search', 'navigate_view']), turn(u2, [CORE, 'web_search', 'navigate_view'])],
      [CORE, 'web_search']
    );
    expect(timeline.changes).toEqual([
      { after: u1, added: ['navigate_view', 'web_search'], removed: [] },
      { after: null, added: [], removed: ['navigate_view'] },
    ]);
    expect(timeline.notOffered).toEqual(['navigate_view']);
  });

  it('keeps the previous set across a turn with no record, and counts called tools as offered', () => {
    const timeline = planToolTimeline(
      [turn(u1, [CORE], ['web_search']), turn(u2, undefined, ['navigate_view'])],
      [CORE, 'web_search']
    );
    expect(timeline.changes).toEqual([{ after: u1, added: ['web_search'], removed: [] }]);
  });

  it('drops excluded tools, which re-writes from their first addition', () => {
    const timeline = planToolTimeline(
      [turn(u1, [CORE, 'web_search', 'mcp_tool'])],
      [CORE, 'web_search'],
      new Set(['mcp_tool'])
    );
    expect(timeline.changes).toEqual([{ after: u1, added: ['web_search'], removed: [] }]);
    expect(timeline.notOffered).toEqual([]);
  });

  it('plans no change for a core-only conversation', () => {
    expect(planToolTimeline([turn(u1, [CORE])], [CORE]).changes).toEqual([]);
  });

  describe('with a loaded start set', () => {
    const start = new Set(['search_knowledge_base', 'web_search']);

    it('adds only what the start set lacks, then appends later changes', () => {
      const timeline = planToolTimeline(
        [turn(u1, [CORE, 'search_knowledge_base', 'web_search', 'mcp_tool'])],
        [CORE, 'search_knowledge_base', 'web_search', 'mcp_tool', 'image_generation'],
        new Set(),
        start
      );
      expect(timeline.changes).toEqual([
        { after: u1, added: ['mcp_tool'], removed: [] },
        { after: null, added: ['image_generation'], removed: [] },
      ]);
      expect(timeline.loaded).toEqual(start);
    });

    it('removes and re-adds a start tool by change message, and keeps it declared while withdrawn', () => {
      const withdrawn = planToolTimeline(
        [turn(u1, [CORE, 'search_knowledge_base', 'web_search'])],
        [CORE, 'search_knowledge_base'],
        new Set(),
        start
      );
      expect(withdrawn.changes).toEqual([{ after: null, added: [], removed: ['web_search'] }]);
      expect(withdrawn.notOffered).toEqual(['web_search']);

      const back = planToolTimeline(
        [turn(u1, [CORE, 'search_knowledge_base', 'web_search']), turn(u2, [CORE, 'search_knowledge_base'])],
        [CORE, 'search_knowledge_base', 'web_search'],
        new Set(),
        start
      );
      expect(back.changes).toEqual([
        { after: u2, added: [], removed: ['web_search'] },
        { after: null, added: ['web_search'], removed: [] },
      ]);
    });

    it('drops an undeclarable start tool from the loaded set', () => {
      const timeline = planToolTimeline(
        [turn(u1, [CORE, 'search_knowledge_base', 'web_search'])],
        [CORE, 'search_knowledge_base'],
        new Set(['web_search']),
        start
      );
      expect(timeline.loaded).toEqual(new Set(['search_knowledge_base']));
      expect(timeline.changes).toEqual([]);
    });
  });
});

describe('startToolNames', () => {
  const shared = (name: string) => !name.startsWith('mcp_');

  it('takes the shared optional tools of the first recorded turn', () => {
    const history = [
      turn(user('u0')),
      turn(user('u1'), [CORE, 'web_search', 'mcp_tool', 'navigate_view']),
      turn(user('u2'), [CORE, 'image_generation']),
    ];
    expect(startToolNames(history, [CORE, 'recharts'], shared)).toEqual(['navigate_view', 'web_search']);
  });

  it('takes the current offer on a new chat', () => {
    expect(startToolNames([], [CORE, 'web_search', 'mcp_tool', DEFERRED_ANCHOR_TOOL_NAME], shared)).toEqual([
      'web_search',
    ]);
  });
});

describe('estimateToolDefinitionTokens', () => {
  it('counts about three characters of schema JSON per token', () => {
    const one = tool('web_search');
    expect(estimateToolDefinitionTokens([one])).toBe(Math.ceil(JSON.stringify(one.toolSchema).length / 3));
    expect(estimateToolDefinitionTokens([])).toBe(0);
  });
});

describe('applyToolTimeline', () => {
  const guidance = new Map([['web_search', 'search guidance']]);

  it('inserts each change after its turn, with guidance for the tools it adds', () => {
    const u1 = user('u1');
    const a1 = assistant('a1');
    const u2 = user('u2');
    const out = applyToolTimeline(
      [sys('head'), u1, a1, u2],
      [
        { after: u1, added: ['web_search'], removed: [] },
        { after: null, added: ['navigate_view'], removed: ['web_search'] },
      ],
      guidance
    );
    expect(out).toEqual([
      sys('head'),
      u1,
      change(['web_search'], [], 'search guidance'),
      a1,
      u2,
      change(['navigate_view'], ['web_search']),
    ]);
  });

  it('keeps the earlier turns byte-identical when the next turn appends a change', () => {
    const u1 = user('u1');
    const first = applyToolTimeline([sys('head'), u1], [{ after: null, added: ['web_search'], removed: [] }], guidance);
    const second = applyToolTimeline(
      [sys('head'), u1, assistant('a1'), user('u2')],
      [
        { after: u1, added: ['web_search'], removed: [] },
        { after: null, added: ['navigate_view'], removed: [] },
      ],
      guidance
    );
    expect(second.slice(0, first.length)).toEqual(first);
  });

  it('carries a change whose turn is missing or unplaceable into the next one', () => {
    const u1 = user('u1');
    const u1b = user('u1b');
    const u2 = user('u2');
    const out = applyToolTimeline(
      [u1, u1b, assistant('a1'), u2],
      [
        { after: u1, added: ['web_search'], removed: [] },
        { after: user('gone'), added: ['navigate_view'], removed: [] },
        { after: null, added: [], removed: ['web_search'] },
      ]
    );
    expect(out).toEqual([u1, u1b, assistant('a1'), u2, change(['navigate_view'])]);
  });

  it('places the last change after the current user message when its own turn is gone', () => {
    const u2 = user('u2');
    const out = applyToolTimeline(
      [user('u1'), assistant('a1'), u2],
      [{ after: user('gone'), added: ['web_search'], removed: [] }]
    );
    expect(out.at(-1)).toEqual(change(['web_search']));
  });

  it('is dropped with the other tool-only messages when a turn continues without tools', () => {
    const inserted = applyToolTimeline([user('u1')], [{ after: null, added: ['web_search'], removed: [] }]);
    expect(inserted).toHaveLength(2);
    expect(stripToolDependentMessages(inserted)).toEqual([user('u1')]);
  });
});

describe('lookbackAnchor', () => {
  const a0 = assistant('a0');
  const u1 = user('u1');
  const history = [user('u0'), a0, u1, assistant('a1')];

  it('is the message before the last replayed prompt when a change follows that prompt', () => {
    expect(lookbackAnchor(history, u1, [{ after: u1, added: ['web_search'], removed: [] }])).toBe(a0);
  });

  it('is undefined when the last turn changed nothing, or there is no earlier message', () => {
    expect(lookbackAnchor(history, u1, [{ after: null, added: ['web_search'], removed: [] }])).toBeUndefined();
    expect(lookbackAnchor([u1], u1, [{ after: u1, added: ['web_search'], removed: [] }])).toBeUndefined();
    expect(lookbackAnchor(history, undefined, [])).toBeUndefined();
  });
});

describe('declareDeferredTools', () => {
  it('defers the optional tools, keeps the core tool loaded, declares removed tools and the anchor', async () => {
    const offered = [tool('web_search'), tool(CORE)];
    const declared = declareDeferredTools(offered, [tool('navigate_view')]);

    expect(names(declared)).toEqual(['web_search', CORE, 'navigate_view', DEFERRED_ANCHOR_TOOL_NAME]);
    expect(deferredNames(declared)).toEqual(['web_search', 'navigate_view', DEFERRED_ANCHOR_TOOL_NAME]);
    expect(offered.some(t => t.toolSchema.defer_loading)).toBe(false);
    await expect(declared[2].toolFn({})).resolves.toContain('not available');
    await expect(declared[3].toolFn({})).resolves.toContain('not available');
    await expect(declared[0].toolFn({})).resolves.toBe('ok');
  });

  it('keeps start-set tools loaded, including a withdrawn one, which still refuses', async () => {
    const declared = declareDeferredTools(
      [tool('search_knowledge_base'), tool('image_generation'), tool(CORE)],
      [tool('web_search')],
      new Set(['search_knowledge_base', 'web_search'])
    );

    expect(deferredNames(declared)).toEqual(['image_generation', DEFERRED_ANCHOR_TOOL_NAME]);
    await expect(declared[3].toolFn({})).resolves.toContain('not available');
  });
});

describe('undoDeferredTools', () => {
  it('restores the non-deferred shape: no change messages, no declared-only tools, guidance as a system message', () => {
    const u1 = user('u1');
    const tools = declareDeferredTools([tool(CORE), tool('web_search')], [tool('navigate_view')]);
    const messages = applyToolTimeline(
      [sys('head'), u1, assistant('a1'), user('u2')],
      [
        { after: u1, added: ['navigate_view', 'web_search'], removed: [] },
        { after: null, added: [], removed: ['navigate_view'] },
      ]
    );

    const undone = undoDeferredTools(messages, tools, {
      declaredOnly: new Set(['navigate_view', DEFERRED_ANCHOR_TOOL_NAME]),
      guidance: 'search guidance',
    });

    expect(names(undone.tools)).toEqual([CORE, 'web_search']);
    expect(undone.tools?.every(t => !('defer_loading' in t.toolSchema))).toBe(true);
    expect(undone.messages).toEqual([
      sys('head'),
      { role: 'system', content: 'search guidance', requiresTool: DEFERRED_TOOLS_MARKER },
      u1,
      assistant('a1'),
      user('u2'),
    ]);
  });

  it('is an identity copy when nothing was deferred', () => {
    const messages = [user('u1')];
    const tools = [tool('web_search')];
    const undone = undoDeferredTools(messages, tools, { declaredOnly: new Set(), guidance: '' });
    expect(undone.messages).toEqual(messages);
    expect(undone.tools).toEqual(tools);
    expect(undoDeferredTools(messages, undefined, { declaredOnly: new Set(), guidance: '' }).tools).toBeUndefined();
  });
});

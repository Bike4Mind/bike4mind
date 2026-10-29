import { describe, expect, it } from 'vitest';
import type { IMessage } from '@bike4mind/common';
import { stripToolDependentMessages, type ICompletionOptionTools } from '@bike4mind/llm-adapters';
import {
  DEFERRED_TOOLS_MARKER,
  insertToolChangeMessage,
  planDeferredTools,
  selectDeferrableToolNames,
  undoDeferredTools,
} from './deferredToolLoading';

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

describe('selectDeferrableToolNames', () => {
  it('defers every optional tool, sorted and de-duplicated, when a core tool is offered', () => {
    expect(selectDeferrableToolNames(['web_search', 'current_model_details', 'navigate_view', 'web_search'])).toEqual([
      'navigate_view',
      'web_search',
    ]);
  });

  it('defers nothing without a core tool, since the API needs one loaded tool', () => {
    expect(selectDeferrableToolNames(['web_search', 'navigate_view'])).toEqual([]);
  });
});

describe('planDeferredTools', () => {
  const offered = ['web_search', 'current_model_details', 'current_datetime'].map(tool);
  const allowed = new Set(['web_search', 'current_datetime']);

  it('marks the optional tools deferred and adds them by reference with their guidance', () => {
    const plan = planDeferredTools(offered, allowed, [
      { tool: 'web_search', text: 'search guidance' },
      { tool: 'current_datetime', text: 'time guidance' },
      { tool: 'search_knowledge_base', text: 'not offered' },
    ]);

    expect(names(plan.tools)).toEqual(['web_search', 'current_model_details', 'current_datetime']);
    expect(deferredNames(plan.tools)).toEqual(['web_search', 'current_datetime']);
    expect(plan.changeMessage).toEqual({
      role: 'system',
      requiresTool: DEFERRED_TOOLS_MARKER,
      content: [
        { type: 'tool_addition', tool: { type: 'tool_reference', name: 'current_datetime' } },
        { type: 'tool_addition', tool: { type: 'tool_reference', name: 'web_search' } },
        { type: 'text', text: 'time guidance\n\nsearch guidance' },
      ],
    });
  });

  it('leaves the input tools untouched', () => {
    planDeferredTools(offered, allowed);
    expect(offered.some(t => t.toolSchema.defer_loading)).toBe(false);
  });

  it('defers only what the caller allowed', () => {
    const plan = planDeferredTools(offered, new Set(['web_search']));
    expect(deferredNames(plan.tools)).toEqual(['web_search']);
  });

  it('returns the tools unchanged and no message when nothing can be deferred', () => {
    const plan = planDeferredTools(['web_search'].map(tool), new Set(['web_search']));
    expect(plan.changeMessage).toBeNull();
    expect(deferredNames(plan.tools)).toEqual([]);
  });

  it('produces the same bytes whatever order the tools and guidance arrive in', () => {
    const a = planDeferredTools(offered, allowed, [
      { tool: 'web_search', text: 'search guidance' },
      { tool: 'current_datetime', text: 'time guidance' },
    ]);
    const b = planDeferredTools([...offered].reverse(), allowed, [
      { tool: 'current_datetime', text: 'time guidance' },
      { tool: 'web_search', text: 'search guidance' },
    ]);
    expect(JSON.stringify(a.changeMessage)).toBe(JSON.stringify(b.changeMessage));
  });
});

describe('insertToolChangeMessage', () => {
  const change: IMessage = { role: 'system', content: [], requiresTool: DEFERRED_TOOLS_MARKER };

  it('pins the message after the first answered user turn', () => {
    const messages = [sys('head'), user('u1'), assistant('a1'), user('u2'), assistant('a2'), user('u3')];
    expect(insertToolChangeMessage(messages, change)).toEqual([
      sys('head'),
      user('u1'),
      change,
      assistant('a1'),
      user('u2'),
      assistant('a2'),
      user('u3'),
    ]);
  });

  it('puts it last on a first turn', () => {
    expect(insertToolChangeMessage([sys('head'), user('u1')], change)).toEqual([sys('head'), user('u1'), change]);
  });

  it('lands at the same index on the next turn, so the history prefix stays put', () => {
    const first = insertToolChangeMessage([sys('head'), user('u1')], change);
    const second = insertToolChangeMessage([sys('head'), user('u1'), assistant('a1'), user('u2')], change);
    expect(second.slice(0, first.length)).toEqual(first);
  });

  it('skips a user turn followed by another user turn', () => {
    const messages = [user('u1'), user('u1b'), assistant('a1'), user('u2')];
    expect(insertToolChangeMessage(messages, change)).toEqual([
      user('u1'),
      user('u1b'),
      change,
      assistant('a1'),
      user('u2'),
    ]);
  });

  it('is a copy when there is no message', () => {
    const messages = [user('u1')];
    const out = insertToolChangeMessage(messages, null);
    expect(out).toEqual(messages);
    expect(out).not.toBe(messages);
  });

  it('is dropped with the other tool-only messages when a turn continues without tools', () => {
    const inserted = insertToolChangeMessage([user('u1')], change);
    expect(stripToolDependentMessages(inserted)).toEqual([user('u1')]);
  });
});

describe('undoDeferredTools', () => {
  it('restores the non-deferred shape: no change message, no defer_loading, guidance as a system message', () => {
    const plan = planDeferredTools(['current_model_details', 'web_search'].map(tool), new Set(['web_search']), [
      { tool: 'web_search', text: 'search guidance' },
    ]);
    const messages = insertToolChangeMessage(
      [sys('head'), user('u1'), assistant('a1'), user('u2')],
      plan.changeMessage
    );

    const undone = undoDeferredTools(messages, plan.tools);

    expect(deferredNames(undone.tools!)).toEqual([]);
    expect(undone.tools?.every(t => !('defer_loading' in t.toolSchema))).toBe(true);
    expect(undone.messages).toEqual([
      sys('head'),
      { role: 'system', content: 'search guidance', requiresTool: DEFERRED_TOOLS_MARKER },
      user('u1'),
      assistant('a1'),
      user('u2'),
    ]);
  });

  it('is an identity copy when nothing was deferred', () => {
    const messages = [user('u1')];
    const tools = [tool('web_search')];
    const undone = undoDeferredTools(messages, tools);
    expect(undone.messages).toEqual(messages);
    expect(undone.tools).toEqual(tools);
    expect(undoDeferredTools(messages, undefined).tools).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import type { GatedToolCall } from '@bike4mind/agents';
import { classifyToolPermission, selectGatedToolCall, shouldWithholdToolCall } from './toolPermissions';

let nextId = 0;
const call = (name: string, input: unknown = {}): GatedToolCall => ({ id: `toolu_${nextId++}`, name, input });

describe('classifyToolPermission', () => {
  it('returns denied for explicitly denied tools (highest priority)', () => {
    expect(classifyToolPermission('web_search', [], ['web_search'])).toBe('denied');
    expect(classifyToolPermission('send_slack_message', ['send_slack_message'], ['send_slack_message'])).toBe('denied');
  });

  it('returns allowed for explicitly approved tools', () => {
    expect(classifyToolPermission('send_slack_message', ['send_slack_message'], [])).toBe('allowed');
  });

  it('returns allowed for always-safe read-only tools', () => {
    expect(classifyToolPermission('web_search', [], [])).toBe('allowed');
    expect(classifyToolPermission('deep_research', [], [])).toBe('allowed');
  });

  it('returns allowed for every read-only tool, not just the ones someone remembered to list', () => {
    // Regression: these all declare `none` side effects and used to be gated purely because
    // they were missing from a hand-kept Set - which is what made agent mode stop and ask
    // "may I check what time it is?" once per turn.
    for (const tool of [
      'current_datetime',
      'sunrise_sunset',
      'planet_visibility',
      'wikipedia_on_this_day',
      'moon_phase',
      'iss_tracker',
      'mission_status',
      'math_evaluate',
      'wolfram_alpha',
      'search_knowledge_base',
      'retrieve_knowledge_content',
      'count_knowledge_base',
      'fmp_financial_data',
    ]) {
      expect(classifyToolPermission(tool, [], []), tool).toBe('allowed');
    }
  });

  it('gates a read-only tool the user explicitly denied', () => {
    expect(classifyToolPermission('current_datetime', [], ['current_datetime'])).toBe('denied');
  });

  it('gates an MCP tool even though it could ship its own declaration', () => {
    // Rule 3 runs before the declaration lookup: an MCP tool is third-party, so a
    // side-effect claim travelling with it is not evidence of anything.
    expect(classifyToolPermission('mcp__clock__now', [], [])).toBe('needs_approval');
  });

  it('treats both inline visualization tools (recharts, mermaid_chart) as always-safe', () => {
    // Artifact-only tools must stay paired - otherwise agent mode runs one chart
    // tool silently while pausing the other for approval.
    expect(classifyToolPermission('recharts', [], [])).toBe('allowed');
    expect(classifyToolPermission('mermaid_chart', [], [])).toBe('allowed');
  });

  it('treats all five OptiHashi tools as always-safe', () => {
    // Same risk surface (LLM/solver call + /opti-gated, undoable __uiSideEffect; no stored-data
    // mutation or external call) - must stay grouped so agent mode doesn't auto-run one while
    // pausing its twin, and so the autonomous decompose -> formulate -> solve/schedule loop isn't
    // interrupted by an approval prompt at every step.
    expect(classifyToolPermission('optihashi_decompose', [], [])).toBe('allowed');
    expect(classifyToolPermission('optihashi_formulate', [], [])).toBe('allowed');
    expect(classifyToolPermission('optihashi_edit_problem', [], [])).toBe('allowed');
    expect(classifyToolPermission('optihashi_schedule', [], [])).toBe('allowed');
    expect(classifyToolPermission('optihashi_solve', [], [])).toBe('allowed');
  });

  it('returns needs_approval for MCP tools', () => {
    expect(classifyToolPermission('mcp__github__get_issue', [], [])).toBe('needs_approval');
  });

  it('returns needs_approval for known side-effect tools', () => {
    expect(classifyToolPermission('send_slack_message', [], [])).toBe('needs_approval');
    expect(classifyToolPermission('image_generation', [], [])).toBe('needs_approval');
    expect(classifyToolPermission('delegate_to_agent', [], [])).toBe('needs_approval');
  });

  it('returns needs_approval for unknown tools (safe default)', () => {
    expect(classifyToolPermission('totally_unknown_tool', [], [])).toBe('needs_approval');
  });
});

describe('shouldWithholdToolCall', () => {
  it('lets an always-safe tool run', () => {
    expect(shouldWithholdToolCall('web_search', [], [])).toBe(false);
  });

  it('lets a session-approved tool run', () => {
    expect(shouldWithholdToolCall('send_slack_message', ['send_slack_message'], [])).toBe(false);
  });

  it('withholds a side-effect tool so its provider is never called', () => {
    expect(shouldWithholdToolCall('image_generation', [], [])).toBe(true);
  });

  it('withholds a denied tool rather than running it and failing afterwards', () => {
    expect(shouldWithholdToolCall('web_search', [], ['web_search'])).toBe(true);
  });
});

describe('selectGatedToolCall', () => {
  it('returns null when nothing was withheld', () => {
    expect(selectGatedToolCall([], [], [])).toBeNull();
  });

  it('carries the tool_use id so the executor can replay the call after approval', () => {
    const gated = call('send_slack_message', { channel: '#general', text: 'hi' });
    expect(selectGatedToolCall([gated], [], [])).toEqual({
      toolName: 'send_slack_message',
      toolInput: { channel: '#general', text: 'hi' },
      verdict: 'needs_approval',
      toolCallId: gated.id,
    });
  });

  it('returns null when the withheld call is on a since-approved tool', () => {
    expect(selectGatedToolCall([call('send_slack_message')], ['send_slack_message'], [])).toBeNull();
  });

  it('returns denied for a denied tool even when other calls only need approval', () => {
    const denied = call('image_generation', { prompt: 'cat' });
    expect(selectGatedToolCall([call('send_slack_message', { text: 'hi' }), denied], [], ['image_generation'])).toEqual({
      toolName: 'image_generation',
      toolInput: { prompt: 'cat' },
      verdict: 'denied',
      toolCallId: denied.id,
    });
  });

  it('returns denied as soon as it sees a denied call, regardless of order', () => {
    const calls = [call('image_generation', { prompt: 'cat' }), call('send_slack_message', { text: 'hi' })];
    expect(selectGatedToolCall(calls, [], ['image_generation'])?.verdict).toBe('denied');
  });

  it('returns the FIRST needs_approval call when one iteration withheld several', () => {
    // Single-toolName pendingPermission requires a deterministic pick - first wins.
    const calls = [call('send_slack_message', { text: 'first' }), call('image_generation', { prompt: 'second' })];
    expect(selectGatedToolCall(calls, [], [])).toMatchObject({
      toolName: 'send_slack_message',
      toolInput: { text: 'first' },
      verdict: 'needs_approval',
    });
  });

  it('treats MCP tools as needing approval', () => {
    expect(selectGatedToolCall([call('mcp__github__get_issue', { number: 1 })], [], [])).toMatchObject({
      toolName: 'mcp__github__get_issue',
      toolInput: { number: 1 },
      verdict: 'needs_approval',
    });
  });

  it('treats unknown tools as needing approval (safe default)', () => {
    expect(selectGatedToolCall([call('mystery_tool')], [], [])?.verdict).toBe('needs_approval');
  });
});
